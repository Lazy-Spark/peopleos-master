"""JD parse pipeline (Module 1 step 1).

Calls the versioned ``jd_parse`` prompt (structured extraction) through the LLM
wrapper, validates the output against ``JDStructured`` with retry-then-human-review,
and returns a ``ParseJobDescriptionResponse``.

OFFLINE DEV: when ``ANTHROPIC_API_KEY`` is absent the LLM call raises
``LLMUnavailable``; this module catches that and returns a CLEARLY-MARKED
deterministic keyword fallback so the full pipeline still runs offline. The
fallback never invents requirements beyond what the text plainly contains.
"""

from __future__ import annotations

import re

import structlog

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm, split_thinking
from ..prompts.jd_parse import (
    PROMPT_VERSION,
    build_jd_parse_system_prompt,
    build_jd_parse_user_prompt,
)
from ..schemas import JDStructured, ParseJobDescriptionRequest, ParseJobDescriptionResponse, RequiredSkill
from ..scoring.synonyms import canonical_skill
from ..validation import validate_or_review

log = structlog.get_logger(__name__)

# Seniority phrasing -> RoleLevel (used by the offline fallback only).
_LEVEL_HINTS: list[tuple[str, str]] = [
    ("intern", "INTERN"),
    ("principal", "PRINCIPAL"),
    ("staff", "STAFF"),
    ("senior", "SENIOR"),
    ("junior", "JUNIOR"),
    ("entry", "JUNIOR"),
    ("lead", "MANAGER"),
    ("manager", "MANAGER"),
    ("director", "DIRECTOR"),
    ("vp", "VP"),
    ("vice president", "VP"),
]

_YOE_RE = re.compile(r"(\d{1,2})\s*\+?\s*years?", re.IGNORECASE)


async def parse_job_description(
    req: ParseJobDescriptionRequest,
    *,
    settings: Settings | None = None,
) -> ParseJobDescriptionResponse:
    """Parse free-text JD into JDStructured (LLM, with offline fallback)."""
    settings = settings or get_settings()

    system = build_jd_parse_system_prompt()
    user = build_jd_parse_user_prompt(req.jdText)

    async def _llm_call(prompt: str) -> str:
        text = await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1024,
                temperature=0.0,
                run_name="module1.jd_parse",
                tags=["module1", "jd_parse", PROMPT_VERSION],
            ),
            settings=settings,
        )
        # JD parse has no <thinking>, but strip defensively for consistency.
        return split_thinking(text).answer

    try:
        jd = await validate_or_review(
            JDStructured,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "jobId": req.jobId},
            module="module1",
            task="jd_parse",
        )
        return ParseJobDescriptionResponse(jdStructured=jd, modelVersion=settings.model_version)
    except LLMUnavailable:
        # OFFLINE FALLBACK — deterministic keyword parse, clearly marked.
        log.info("jd_parse_offline_fallback", jobId=req.jobId)
        jd = _heuristic_jd(req.jdText)
        return ParseJobDescriptionResponse(
            jdStructured=jd,
            modelVersion=f"{settings.model_version}+offline_fallback",
        )


def _heuristic_jd(jd_text: str) -> JDStructured:
    """Deterministic offline JD parse (clearly marked stub).

    Pulls a required-YoE number, infers a role level from seniority words, and
    treats lines under a 'Requirements'/'Responsibilities' heading as signals.
    Skills are taken from explicit 'Required skills:'/'Preferred skills:' lines.
    """
    lower = jd_text.lower()

    required_yoe: float | None = None
    m = _YOE_RE.search(jd_text)
    if m:
        required_yoe = float(m.group(1))

    role_level: str | None = None
    for hint, level in _LEVEL_HINTS:
        if hint in lower:
            role_level = level
            break

    required_skills: list[RequiredSkill] = []
    preferred_skills: list[str] = []
    responsibilities: list[str] = []

    section: str | None = None
    for line in jd_text.splitlines():
        stripped = line.strip(" \t-•*")
        if not stripped:
            continue
        low = stripped.lower()
        if low.startswith(("required skill", "must have", "requirements")):
            section = "required"
            after = stripped.split(":", 1)[1] if ":" in stripped else ""
            required_skills.extend(_split_skills_required(after))
            continue
        if low.startswith(("preferred skill", "nice to have", "nice-to-have", "a plus")):
            section = "preferred"
            after = stripped.split(":", 1)[1] if ":" in stripped else ""
            preferred_skills.extend(_split_skills_plain(after))
            continue
        if low.startswith(("responsibilit", "you will", "what you")):
            section = "responsibilities"
            after = stripped.split(":", 1)[1] if ":" in stripped else ""
            if after.strip():
                responsibilities.append(after.strip())
            continue
        if section == "responsibilities":
            responsibilities.append(stripped)

    return JDStructured(
        requiredSkills=required_skills,
        preferredSkills=preferred_skills,
        requiredYoe=required_yoe,
        niceToHaveYoe=None,
        roleLevel=role_level,  # type: ignore[arg-type]  # validated by Literal
        keyResponsibilities=responsibilities,
        teamContext=None,
        reportingStructure=None,
    )


_SKILL_SPLIT = re.compile(r"[,;|/]| and ")


def _split_skills_required(text: str) -> list[RequiredSkill]:
    out: list[RequiredSkill] = []
    for tok in _SKILL_SPLIT.split(text):
        name = tok.strip().strip(".")
        if name:
            out.append(RequiredSkill(canonicalName=canonical_skill(name), importance="CRITICAL"))
    return out


def _split_skills_plain(text: str) -> list[str]:
    out: list[str] = []
    for tok in _SKILL_SPLIT.split(text):
        name = tok.strip().strip(".")
        if name:
            out.append(canonical_skill(name))
    return out
