"""Module 8 — internal MOVE recommendation (employee-facing, ADVISORY).

LLM path (prompt standards #1/#2/#4/#5/#6/#7): build the XML-tagged system prompt
(optionally personalised with orgContext), pass the target role + the skill match (the
``matchedSkills`` the employee already has and the ``missingSkills`` the role still
requires) + the readiness tier + a NON-PII employee context, call Claude, and validate the
JSON against an internal Pydantic model with the shared retry / human-review path. The raw
match score is NOT passed into the prompt, so the text cannot leak it (the employee sees
readiness + the plan, not a number).

The matching itself is computed UPSTREAM by the skill graph (the Node API's
``skillGap(employee, role)`` → matched / missing / coverage → matchScore + readiness);
this surface only narrates and plans over that result.

GROUNDING is enforced, not merely instructed: regardless of what the model returns, this
module forces the ``developmentPlan`` to cover EXACTLY the missing skills — it DROPS any
step for a skill that is not a genuine missing skill (including any already-matched skill
the model wrongly turns into a step) and BACK-FILLS a templated step for any missing skill
the model omitted, so the plan has exactly one step per missing skill in target-role order.
This mirrors the Module 6 growth_path grounding. The biasCheck is forced to "no protected
attribute influenced this" (the recommendation is computed purely from the skill match,
standard #4).

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a deterministic templated fitSummary + one step
per missing skill — clearly marked with an ``[OFFLINE]`` prefix — so the surface works with
no network/keys. modelVersion is then suffixed ``+offline_fallback``.
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.mobility_recommend import (
    PROMPT_VERSION,
    build_mobility_recommend_system_prompt,
    build_mobility_recommend_user_prompt,
)
from ..schemas import (
    BiasCheck,
    Confidence,
    DevelopmentStep,
    MobilityRecommendRequest,
    MobilityRecommendResponse,
)
from ..validation import validate_or_review

log = structlog.get_logger(__name__)


class _RecommendContent(BaseModel):
    """Internal validation model for the model's JSON (content only).

    The version fields + the forced biasCheck are stamped on by this module, and the
    developmentPlan is re-grounded after validation, so this is a lean subset of
    ``MobilityRecommendResponse``.
    """

    fitSummary: str
    developmentPlan: list[DevelopmentStep] = Field(default_factory=list)
    confidence: Confidence
    biasCheck: BiasCheck = Field(default_factory=BiasCheck)


def _norm(name: str) -> str:
    """Case/space-insensitive normalisation for skill-name matching."""
    return name.strip().casefold()


def _ordered_missing(req: MobilityRecommendRequest) -> list[str]:
    """The missing skills the plan must cover (order preserved, de-duplicated).

    This is the canonical set the development plan is grounded on. De-duplicates the
    supplied missingSkills (so a skill listed twice yields one step) while preserving
    first-seen order. The API computes missingSkills from skillGap, but we de-dupe
    defensively so the plan is always one-step-per-distinct-missing-skill.
    """
    ordered: list[str] = []
    seen: set[str] = set()
    for skill in req.missingSkills:
        key = _norm(skill)
        if not key or key in seen:
            continue
        seen.add(key)
        ordered.append(skill)
    return ordered


def _generic_resource(skill: str) -> str:
    """A generic-but-useful suggested resource when nothing specific fits."""
    return f"An introductory {skill} course or guided on-the-job practice"


def _generic_action(skill: str) -> str:
    """A concrete, development-oriented default action for a missing skill."""
    return (
        f"Build {skill} through a focused course plus hands-on practice on a current "
        "project, and ask your manager for a stretch assignment that uses it."
    )


def _templated_step(skill: str) -> DevelopmentStep:
    """A deterministic development step for a missing skill (offline + back-fill)."""
    return DevelopmentStep(
        skill=skill,
        action=_generic_action(skill),
        suggestedResource=_generic_resource(skill),
    )


def _ground_development_plan(
    model_steps: list[DevelopmentStep],
    missing: list[str],
) -> list[DevelopmentStep]:
    """Force the model's plan onto the true missing-skill set (grounding guard).

    - DROPS any step whose skill is not a genuine missing skill (so the plan can never
      contain a step for an already-matched skill or an invented one).
    - BACK-FILLS a templated step for any missing skill the model omitted, so the plan
      always has exactly one step per missing skill.
    Steps are returned in target-role (missing) order.
    """
    by_name: dict[str, DevelopmentStep] = {}
    missing_keys = {_norm(s) for s in missing}
    for step in model_steps:
        key = _norm(step.skill)
        if key in missing_keys and key not in by_name:
            by_name[key] = step

    grounded: list[DevelopmentStep] = []
    for skill in missing:
        model_step = by_name.get(_norm(skill))
        if model_step is None:
            grounded.append(_templated_step(skill))
        else:
            # Pin the step's skill name to the canonical missing-skill spelling.
            grounded.append(model_step.model_copy(update={"skill": skill}))
    return grounded


# ── Offline deterministic templates (clearly marked) ───────────────────────────────────
_READINESS_PHRASE: dict[str, str] = {
    "READY_NOW": "you are ready for this move now",
    "READY_SOON": "you are close — a small amount of development would get you there",
    "STRETCH": "this is a stretch goal worth working toward over time",
}


def _role_descriptor(req: MobilityRecommendRequest) -> str:
    """A short non-PII current-role descriptor for the offline summary, e.g. "Senior
    Engineer in Engineering"; falls back to "your current role" when unknown."""
    ctx = req.employeeContext
    if ctx is None:
        return "your current role"
    role = ctx.roleTitle or "your current role"
    if ctx.department:
        return f"{role} in {ctx.department}"
    return role


def _offline_fit_summary(req: MobilityRecommendRequest, missing: list[str]) -> str:
    """Deterministic, clearly-marked fit summary grounded in the supplied match."""
    readiness_txt = _READINESS_PHRASE.get(req.readiness, "this is a possible internal move")
    lead = (
        f"[OFFLINE] Based on your skills, {readiness_txt} into {req.targetRoleTitle} "
        f"(from {_role_descriptor(req)})."
    )
    if req.matchedSkills:
        matched_txt = ", ".join(req.matchedSkills[:4])
        body = f" You already bring {matched_txt}."
    else:
        body = ""
    if missing:
        plural = "skill" if len(missing) == 1 else "skills"
        body += f" To close the gap, develop {len(missing)} {plural}: {', '.join(missing)}."
    else:
        body += " You already hold every skill this role requires."
    tail = " This is an advisory suggestion to consider, not a decision."
    return lead + body + tail


def _offline_response(
    req: MobilityRecommendRequest, settings: Settings
) -> MobilityRecommendResponse:
    """Assemble the deterministic offline move recommendation (clearly marked)."""
    missing = _ordered_missing(req)
    plan = [_templated_step(skill) for skill in missing]
    # READY_NOW/READY_SOON gaps are unambiguous; STRETCH is inherently less certain.
    confidence: Confidence = "high" if req.readiness != "STRETCH" else "medium"
    return MobilityRecommendResponse(
        fitSummary=_offline_fit_summary(req, missing),
        developmentPlan=plan,
        confidence=confidence,
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
        modelVersion=f"{settings.model_version}+offline_fallback",
        promptVersion=PROMPT_VERSION,
    )


async def recommend_move(
    req: MobilityRecommendRequest, *, settings: Settings | None = None
) -> MobilityRecommendResponse:
    """Recommend an internal move + a development plan (spec Module 8).

    GROUNDED ONLY in the supplied matched/missing skills: the ``developmentPlan`` is forced
    to cover EXACTLY the missing skills (invented / already-matched skills are dropped,
    omitted missing skills are back-filled), and the ``biasCheck`` is forced to "no
    protected attribute influenced this" (the recommendation is computed purely from the
    skill match, standard #4). Offline (no ANTHROPIC_API_KEY): a deterministic templated
    fit summary + one step per missing skill, clearly marked.
    """
    settings = settings or get_settings()
    missing = _ordered_missing(req)
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None
    employee_context = req.employeeContext.model_dump() if req.employeeContext is not None else None

    system = build_mobility_recommend_system_prompt(org_context=org_context)
    user = build_mobility_recommend_user_prompt(
        target_role_title=req.targetRoleTitle,
        required_skills=req.requiredSkills,
        matched_skills=req.matchedSkills,
        missing_skills=req.missingSkills,
        readiness=req.readiness,
        employee_context=employee_context,
    )

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1400,
                temperature=0.2,  # advisory prose, but kept grounded
                run_name="module8.mobility_recommend",
                tags=["module8", "mobility", "recommend", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _RecommendContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "targetRoleTitle": req.targetRoleTitle},
            module="module8",
            task="mobility_recommend",
        )
    except LLMUnavailable:
        log.info("mobility_recommend_offline_fallback", orgId=req.orgId)
        return _offline_response(req, settings)

    # Enforce grounding regardless of the model's output: the development plan covers
    # exactly the missing skills (invented / already-matched dropped, omitted back-filled).
    grounded_plan = _ground_development_plan(content.developmentPlan, missing)
    return MobilityRecommendResponse(
        fitSummary=content.fitSummary,
        developmentPlan=grounded_plan,
        confidence=content.confidence,
        # Bias guard (standard #4): the recommendation is computed purely from the skill
        # match — never a protected attribute — so no correction is needed and none is
        # recorded. Forced regardless of the model's self-report.
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
        modelVersion=settings.model_version,
        promptVersion=PROMPT_VERSION,
    )


__all__ = ["recommend_move"]
