"""Module 2d — LinkedIn profile analysis (sidebar extension backend).

Takes an ``AnalyzeLinkedInRequest`` (a consented, scraped LinkedIn profile + the org's
open roles) and returns an ``AnalyzeLinkedInResponse``:
  - a structured ``CandidateProfile`` built from the scraped profile (reusing the
    resume pipeline's skill normalisation),
  - a ``LinkedInRoleMatch`` per supplied role, scored with the EXISTING Module 1
    ``skill_match`` (matchScore / tier / skillMatchPct / topGaps),
  - a short AI summary (LLM, with an offline deterministic fallback) + a biasCheck.

CONSENT: the request schema requires ``consent: true`` (Pydantic ``Literal[True]``);
without it the request fails validation at the boundary (spec: "scrape with consent").

The role matching is DETERMINISTIC and reuses ``app/scoring/skill_match.py`` so a
LinkedIn match is consistent with how Module 1 scores resume candidates. When a role
supplies a parsed ``jdStructured`` we use it directly; when it supplies only ``jdText``
we parse it first (offline-capable). When neither is present that role is scored
against an empty JD (neutral) and flagged in topGaps.
"""

from __future__ import annotations

import structlog

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.linkedin import (
    PROMPT_VERSION,
    build_linkedin_summary_system_prompt,
    build_linkedin_summary_user_prompt,
)
from ..schemas import (
    AnalyzeLinkedInRequest,
    AnalyzeLinkedInResponse,
    BiasCheck,
    CandidateProfile,
    CandidateSkill,
    Education,
    JDStructured,
    LinkedInMatchRole,
    LinkedInRoleMatch,
    LinkedInScrapedProfile,
    WorkExperience,
)
from ..scoring.skill_match import score_skill_match
from ..scoring.synonyms import canonical_skill

log = structlog.get_logger(__name__)

# Tier thresholds on the per-role match score. Mirrors the Module 1 ranker tiers so a
# LinkedIn match reads consistently with a resume-screened candidate's tier.
_TIER_A = 0.80
_TIER_B = 0.65
_TIER_C = 0.45


def _tier(score: float) -> str:
    if score >= _TIER_A:
        return "A"
    if score >= _TIER_B:
        return "B"
    if score >= _TIER_C:
        return "C"
    return "D"


def _normalise_skills(raw_skills: list[str]) -> list[CandidateSkill]:
    """Canonicalise scraped skill strings (reuses the resume pipeline's alias table)."""
    seen: set[str] = set()
    out: list[CandidateSkill] = []
    for raw in raw_skills:
        raw = (raw or "").strip()
        if not raw:
            continue
        canon = canonical_skill(raw)
        key = canon.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(
            CandidateSkill(
                canonicalName=canon,
                rawName=raw if raw != canon else None,
                category="TECHNICAL",
                proficiency=None,
                # LinkedIn-listed skills are self-reported / inferred -> 0.6
                # (spec Layer 3A skill-confidence: resume/inferred = 0.6).
                confidence=0.6,
            )
        )
    return out


def scraped_to_profile(scraped: LinkedInScrapedProfile) -> CandidateProfile:
    """Convert a scraped LinkedIn profile into a structured CandidateProfile.

    Deterministic mapping; reuses skill normalisation so downstream matching is
    consistent with resume-sourced candidates.
    """
    experience = [
        WorkExperience(
            company=(e.company or "").strip() or "Unknown",
            title=(e.title or "").strip() or "Unknown",
            startDate=None,  # LinkedIn date ranges are free-text; not parsed here
            endDate=None,
            description=e.description,
            isCurrent=False,
        )
        for e in scraped.experience
    ]
    education = [
        Education(
            school=(e.school or "").strip() or "Unknown",
            degree=e.degree,
            field=e.field,
            startYear=None,
            endYear=None,
        )
        for e in scraped.education
    ]
    return CandidateProfile(
        name=scraped.name,
        email=None,
        phone=None,
        linkedinUrl=scraped.url,
        githubUrl=None,
        location=scraped.location,
        education=education,
        experience=experience,
        skills=_normalise_skills(scraped.skills),
        certifications=[],
        languages=[],
        publications=[],
        gaps=[],
        totalYoe=None,
    )


async def _resolve_jd(role: LinkedInMatchRole, settings: Settings) -> JDStructured:
    """Return the role's JDStructured, parsing jdText if needed (offline-capable)."""
    if role.jdStructured is not None:
        return role.jdStructured
    if role.jdText and role.jdText.strip():
        from ..pipelines.jd_parse import parse_job_description
        from ..schemas import ParseJobDescriptionRequest

        resp = await parse_job_description(
            ParseJobDescriptionRequest(orgId="linkedin", jobId=role.jobId, jdText=role.jdText),
            settings=settings,
        )
        return resp.jdStructured
    return JDStructured()


async def _match_roles(
    profile: CandidateProfile,
    roles: list[LinkedInMatchRole],
    settings: Settings,
) -> list[LinkedInRoleMatch]:
    """Score the profile against each supplied role using Module 1 skill_match."""
    matches: list[LinkedInRoleMatch] = []
    for role in roles:
        jd = await _resolve_jd(role, settings)
        result = score_skill_match(profile, jd)
        # No requirements to score against -> surface as a gap rather than a fake score.
        top_gaps = list(result.missing[:5])
        if not jd.requiredSkills and not jd.preferredSkills:
            top_gaps = ["No structured requirements available for this role"]
        matches.append(
            LinkedInRoleMatch(
                jobId=role.jobId,
                title=role.title,
                matchScore=result.skill_match,
                tier=_tier(result.skill_match),  # type: ignore[arg-type]  # validated by Literal
                skillMatchPct=result.skill_match_pct,
                topGaps=top_gaps,
            )
        )
    # Best match first (the sidebar shows the strongest role at the top).
    matches.sort(key=lambda m: m.matchScore, reverse=True)
    return matches


def _offline_summary(
    scraped: LinkedInScrapedProfile,
    matches: list[LinkedInRoleMatch],
) -> str:
    """Deterministic offline profile summary (clearly-marked stub)."""
    headline = scraped.headline or "Professional"
    n_exp = len(scraped.experience)
    n_skills = len(scraped.skills)
    best = matches[0] if matches else None
    best_clause = (
        f" Best current-role match: {best.title} (tier {best.tier}, "
        f"{best.skillMatchPct:.0f}% skill coverage)."
        if best
        else " No open roles supplied to benchmark against."
    )
    return (
        f"[OFFLINE SUMMARY] {headline}. Profile shows {n_exp} role(s) and "
        f"{n_skills} listed skill(s).{best_clause} Generated deterministically "
        "without an LLM; verify before acting."
    )


async def _generate_summary(
    scraped: LinkedInScrapedProfile,
    profile: CandidateProfile,
    matches: list[LinkedInRoleMatch],
    settings: Settings,
) -> tuple[str, str]:
    """Return (summary, method). LLM with an offline deterministic fallback."""
    system = build_linkedin_summary_system_prompt()
    match_lines = [
        f"- {m.title}: tier {m.tier}, {m.skillMatchPct:.0f}% skill coverage, "
        f"gaps: {', '.join(m.topGaps) if m.topGaps else 'none'}"
        for m in matches
    ]
    user = build_linkedin_summary_user_prompt(
        profile_json=profile.model_dump_json(),
        role_match_lines=match_lines,
    )
    try:
        raw = await call_llm(
            LLMRequest(
                system=system,
                user=user,
                max_tokens=600,
                temperature=0.3,
                run_name="module2.linkedin_summary",
                tags=["module2", "linkedin", PROMPT_VERSION],
            ),
            settings=settings,
        )
        return raw.strip(), "llm"
    except LLMUnavailable:
        log.info("linkedin_summary_offline_fallback", url=scraped.url)
        return _offline_summary(scraped, matches), "offline_fallback"


async def analyze_linkedin(
    req: AnalyzeLinkedInRequest,
    *,
    settings: Settings | None = None,
) -> AnalyzeLinkedInResponse:
    """Analyse a consented scraped LinkedIn profile + match against open roles (2d)."""
    settings = settings or get_settings()

    # Consent is enforced by the schema (Literal[True]); assert for defence in depth.
    assert req.consent is True

    profile = scraped_to_profile(req.profile)
    matches = await _match_roles(profile, req.roles, settings)
    summary, method = await _generate_summary(req.profile, profile, matches, settings)

    model_version = (
        settings.model_version if method == "llm" else f"{settings.model_version}+offline_fallback"
    )

    return AnalyzeLinkedInResponse(
        summary=summary,
        candidateProfile=profile,
        roleMatches=matches,
        # Deterministic skill match + advisory summary; no identity-based scoring.
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
        modelVersion=model_version,
    )
