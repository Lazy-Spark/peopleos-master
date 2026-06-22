"""Module 2a — Job Description Writer.

Takes a ``WriteJobDescriptionRequest`` (role brief + optional orgContext + the org's
prior JD texts for tone-matched few-shot) and returns a ``GeneratedJobDescription``:
summary / responsibilities / requirements / preferred / benefits / deiStatement, an
assembled ``jdText`` (directly feedable to the Module 1 JD parser), an
``InclusiveLanguageReport`` (inclusive-language pass + biasCheck), and the model /
prompt version.

LLM path (prompt standards #1/#2/#4/#5/#6): build the XML-tagged system prompt with the
org's prior JDs as tone-matched few-shot, call Claude, validate the JSON against an
internal Pydantic model, assemble jdText, then run the deterministic inclusive-language
pass over the assembled text.

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a clearly-marked deterministic JD built from
the role brief, so the surface runs end-to-end with no network. modelVersion is then
suffixed with ``+offline_fallback``.
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.jd_writer import (
    PROMPT_VERSION,
    build_jd_writer_system_prompt,
    build_jd_writer_user_prompt,
)
from ..schemas import (
    GeneratedJobDescription,
    WriteJobDescriptionRequest,
)
from ..validation import validate_or_review
from .inclusive_language import build_inclusive_report

log = structlog.get_logger(__name__)


class _JdContent(BaseModel):
    """Internal validation model for the model's JSON (the content sections only).

    jdText, the inclusive-language report, and the version fields are assembled/added
    by this module — the model does not produce them — so this is a lean subset of
    ``GeneratedJobDescription``.
    """

    title: str
    summary: str
    responsibilities: list[str] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    preferred: list[str] = Field(default_factory=list)
    benefits: list[str] = Field(default_factory=list)
    deiStatement: str


def _assemble_jd_text(content: _JdContent) -> str:
    """Assemble human-readable JD text from the sections (feedable to the JD parser)."""

    def _section(heading: str, items: list[str]) -> str:
        if not items:
            return ""
        bullets = "\n".join(f"- {item}" for item in items)
        return f"\n\n{heading}\n{bullets}"

    parts = [content.title, "", content.summary]
    body = (
        _section("Responsibilities", content.responsibilities)
        + _section("Requirements", content.requirements)
        + _section("Preferred", content.preferred)
        + _section("Benefits", content.benefits)
    )
    text = "\n".join(parts) + body
    if content.deiStatement.strip():
        text += f"\n\nDiversity, Equity & Inclusion\n{content.deiStatement.strip()}"
    return text.strip()


def _offline_content(req: WriteJobDescriptionRequest) -> _JdContent:
    """Deterministic offline JD content (clearly-marked stub).

    Built from the role brief so the surface runs with no LLM. Intentionally generic;
    inclusive by construction (no flagged lexicon terms).
    """
    title = req.roleTitle
    # Avoid "Senior Senior X" when the title already carries the seniority word.
    seniority = (
        f"{req.seniority.capitalize()} "
        if req.seniority and req.seniority.lower() not in title.lower()
        else ""
    )
    team = f" on the {req.teamContext} team" if req.teamContext else ""
    dept = f" within {req.department}" if req.department else ""
    summary = (
        f"[OFFLINE DRAFT] We are hiring a {seniority}{title}{team}{dept}. "
        "This is a deterministic placeholder draft generated without an LLM; review "
        "and tailor it before publishing."
    )
    notes = (req.hiringManagerNotes or "").strip()
    responsibilities = [
        "Own and deliver work aligned to the team's goals",
        "Collaborate closely with peers and stakeholders",
        "Contribute to the quality and reliability of the team's output",
    ]
    if notes:
        responsibilities.insert(0, f"Per the hiring manager: {notes}")
    requirements = [
        "Relevant, demonstrable experience for the role",
        "Strong communication and collaboration skills",
    ]
    return _JdContent(
        title=title,
        summary=summary,
        responsibilities=responsibilities,
        requirements=requirements,
        preferred=["Experience in a similar role or domain"],
        benefits=["Market-rate salary", "Flexible working", "Paid time off"],
        deiStatement=(
            "We welcome applicants of all backgrounds and are committed to an "
            "inclusive hiring process. We encourage you to apply even if you do not "
            "meet every requirement listed."
        ),
    )


async def write_job_description(
    req: WriteJobDescriptionRequest,
    *,
    settings: Settings | None = None,
) -> GeneratedJobDescription:
    """Generate a structured, inclusive, tone-matched job description (spec 2a)."""
    settings = settings or get_settings()
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None

    system = build_jd_writer_system_prompt(
        org_context=org_context,
        prior_jd_examples=req.priorJdExamples,
    )
    user = build_jd_writer_user_prompt(
        role_title=req.roleTitle,
        seniority=req.seniority,
        department=req.department,
        team_context=req.teamContext,
        hiring_manager_notes=req.hiringManagerNotes,
    )

    method = "llm"

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1800,
                temperature=0.4,  # some creativity for copy, still grounded
                run_name="module2.jd_writer",
                tags=["module2", "jd_writer", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _JdContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "roleTitle": req.roleTitle},
            module="module2",
            task="jd_writer",
        )
    except LLMUnavailable:
        log.info("jd_writer_offline_fallback", orgId=req.orgId, roleTitle=req.roleTitle)
        content = _offline_content(req)
        method = "offline_fallback"

    jd_text = _assemble_jd_text(content)
    # Independent inclusive-language verification pass over the assembled copy
    # (spec 2a: "flag gendered words, exclusionary phrases -> suggest alternatives").
    inclusive = build_inclusive_report(jd_text)

    model_version = (
        settings.model_version if method == "llm" else f"{settings.model_version}+offline_fallback"
    )

    return GeneratedJobDescription(
        title=content.title,
        summary=content.summary,
        responsibilities=content.responsibilities,
        requirements=content.requirements,
        preferred=content.preferred,
        benefits=content.benefits,
        deiStatement=content.deiStatement,
        jdText=jd_text,
        inclusiveLanguage=inclusive,
        modelVersion=model_version,
        promptVersion=PROMPT_VERSION,
    )
