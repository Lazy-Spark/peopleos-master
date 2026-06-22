"""Module 2b — Candidate Outreach Generator.

Takes a ``GenerateOutreachRequest`` (the candidate's CONCRETE, unmasked profile + job
context + recruiter name + requested tones) and returns an ``OutreachResult``: one
variant per requested tone, an InMail body, extra subject-line variants for A/B
testing, a biasCheck, and the model / prompt version.

BIAS NOTE: unlike Module 1 scoring, outreach is personalised to the real named person,
so the profile is NOT masked (see GenerateOutreachRequest in copilot.ts). The output
still carries a biasCheck — we run the deterministic inclusive-language scan over the
generated copy so any inadvertently non-inclusive phrasing is recorded for audit.

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a clearly-marked deterministic message per
requested tone, referencing only concrete profile details, so the surface runs with no
network. modelVersion is then suffixed with ``+offline_fallback``.
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.outreach import (
    PROMPT_VERSION,
    build_outreach_system_prompt,
    build_outreach_user_prompt,
)
from ..schemas import (
    BiasCheck,
    CandidateProfile,
    GenerateOutreachRequest,
    OutreachInMail,
    OutreachResult,
    OutreachVariant,
)
from ..validation import validate_or_review
from .inclusive_language import scan_inclusive_language

log = structlog.get_logger(__name__)


class _OutreachContent(BaseModel):
    """Internal validation model for the model's JSON (variants + inMail + subjects).

    biasCheck and the version fields are added by this module, so this is a lean
    subset of ``OutreachResult``.
    """

    variants: list[OutreachVariant] = Field(default_factory=list)
    inMail: OutreachInMail
    subjectVariants: list[str] = Field(default_factory=list)


def _first_name(profile: CandidateProfile) -> str | None:
    if not profile.name:
        return None
    return profile.name.strip().split()[0] if profile.name.strip() else None


def _concrete_detail(profile: CandidateProfile) -> str | None:
    """Pick one real, citable detail from the profile (recent role or top skill)."""
    for exp in profile.experience:
        if exp.company and exp.title:
            return f"your work as {exp.title} at {exp.company}"
        if exp.company:
            return f"your time at {exp.company}"
    if profile.skills:
        return f"your experience with {profile.skills[0].canonicalName}"
    return None


def _offline_body(
    *,
    tone: str,
    greeting: str,
    detail_clause: str,
    job_title: str,
    recruiter_name: str,
) -> str:
    """Deterministic per-tone body (clearly-marked stub)."""
    if tone == "BRIEF":
        return (
            f"{greeting} — {detail_clause}we are hiring a {job_title} and I think it "
            f"could be a strong fit. Open to a short chat?\n\n{recruiter_name}"
        )
    if tone == "FORMAL":
        return (
            f"{greeting},\n\nI am reaching out regarding a {job_title} opportunity. "
            f"{detail_clause.capitalize() if detail_clause else ''}I believe this role "
            "may align well with your background.\n\nIf you are open to it, I would "
            "welcome the chance to share more details.\n\n"
            f"Kind regards,\n{recruiter_name}"
        )
    # WARM (default)
    return (
        f"{greeting},\n\nI came across your profile and {detail_clause}wanted to reach "
        f"out about an opening for a {job_title} on our team. I think it could be a great "
        "fit for what you do best.\n\nWould you be open to a quick chat this week?\n\n"
        f"Best,\n{recruiter_name}"
    )


def _offline_content(req: GenerateOutreachRequest) -> _OutreachContent:
    """Deterministic offline outreach (clearly-marked stub).

    References only concrete profile details (never invents). Produces one variant per
    requested tone, an InMail, and subject-line A/B variants.
    """
    first = _first_name(req.profile)
    greeting = f"Hi {first}" if first else "Hello"
    detail = _concrete_detail(req.profile)
    detail_clause = f"{detail} stood out — " if detail else ""

    variants: list[OutreachVariant] = []
    for tone in req.tones:
        subject = (
            f"{req.jobTitle} opportunity"
            if tone == "FORMAL"
            else (f"{req.jobTitle} @ our team" if tone == "BRIEF" else f"An opportunity: {req.jobTitle}")
        )
        body = "[OFFLINE DRAFT] " + _offline_body(
            tone=tone,
            greeting=greeting,
            detail_clause=detail_clause,
            job_title=req.jobTitle,
            recruiter_name=req.recruiterName,
        )
        variants.append(OutreachVariant(tone=tone, subject=subject, body=body))

    in_mail = OutreachInMail(
        subject=f"{req.jobTitle} opportunity",
        body=(
            f"[OFFLINE DRAFT] {greeting}, I'm reaching out about a {req.jobTitle} role "
            f"that may align with your background. Would you be open to connecting?\n\n"
            f"{req.recruiterName}"
        ),
    )
    subject_variants = [
        f"{req.jobTitle} opportunity",
        "A role that fits your background",
        f"We're hiring a {req.jobTitle}",
    ]
    return _OutreachContent(variants=variants, inMail=in_mail, subjectVariants=subject_variants)


def _build_bias_check(content: _OutreachContent) -> BiasCheck:
    """Run the inclusive-language scan over all generated copy for the biasCheck.

    Outreach copy is not rewritten automatically (it is human-reviewed before send),
    so correctionApplied is False; biasIndicatorsDetected records flagged categories.
    """
    corpus_parts: list[str] = []
    for v in content.variants:
        corpus_parts.append(v.subject)
        corpus_parts.append(v.body)
    if content.inMail.subject:
        corpus_parts.append(content.inMail.subject)
    corpus_parts.append(content.inMail.body)
    corpus_parts.extend(content.subjectVariants)
    flags = scan_inclusive_language("\n".join(corpus_parts))
    indicators = sorted({f"{f.category.lower()}_language" for f in flags})
    return BiasCheck(biasIndicatorsDetected=indicators, correctionApplied=False)


async def generate_outreach(
    req: GenerateOutreachRequest,
    *,
    settings: Settings | None = None,
) -> OutreachResult:
    """Generate personalised candidate outreach (spec 2b)."""
    settings = settings or get_settings()
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None

    system = build_outreach_system_prompt(org_context=org_context)
    user = build_outreach_user_prompt(
        profile_json=req.profile.model_dump_json(),
        job_title=req.jobTitle,
        job_summary=req.jobSummary,
        recruiter_name=req.recruiterName,
        tones=list(req.tones),
    )

    method = "llm"

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1600,
                temperature=0.6,  # outreach benefits from warmth/variety
                run_name="module2.outreach",
                tags=["module2", "outreach", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _OutreachContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "jobId": req.jobId, "candidateId": req.candidateId},
            module="module2",
            task="outreach",
        )
    except LLMUnavailable:
        log.info("outreach_offline_fallback", orgId=req.orgId, candidateId=req.candidateId)
        content = _offline_content(req)
        method = "offline_fallback"

    bias_check = _build_bias_check(content)
    model_version = (
        settings.model_version if method == "llm" else f"{settings.model_version}+offline_fallback"
    )

    return OutreachResult(
        variants=content.variants,
        inMail=content.inMail,
        subjectVariants=content.subjectVariants,
        biasCheck=bias_check,
        modelVersion=model_version,
        promptVersion=PROMPT_VERSION,
    )
