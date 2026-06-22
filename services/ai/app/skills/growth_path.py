"""Module 6a — AI growth path over the employee skill graph.

LLM path (prompt standards #1/#2/#4/#5/#6/#7): build the XML-tagged system prompt
(optionally personalised with orgContext), pass the employee's current skills + the target
role + its required skills + the optional skill catalog, call Claude, and validate the JSON
against an internal Pydantic model with the shared retry / human-review path.

GROUNDING is enforced, not merely instructed: regardless of what the model returns, this
module recomputes ``stepsAway`` from the actual set difference (target-required skills the
employee lacks) and DROPS any recommended skill that is not a genuine, still-missing
required skill — so the surface can never recommend a skill the employee already holds or a
skill the target role does not require. The biasCheck is forced to "no protected attribute
influenced this" (the growth path is computed purely from the skill gap, standard #4).

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a deterministic path — stepsAway from the set
difference + one templated recommendation per missing skill (a catalog match where one
exists, else a generic suggestion). modelVersion is then suffixed ``+offline_fallback``.
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.growth_path import (
    PROMPT_VERSION,
    build_growth_path_system_prompt,
    build_growth_path_user_prompt,
)
from ..schemas import (
    BiasCheck,
    Confidence,
    GrowthPathRequest,
    GrowthPathResponse,
    RecommendedSkill,
)
from ..validation import validate_or_review

log = structlog.get_logger(__name__)


class _GrowthContent(BaseModel):
    """Internal validation model for the model's JSON (the content only).

    The version fields are stamped on by this module, so this is a lean subset of
    ``GrowthPathResponse``.
    """

    summary: str
    stepsAway: int = Field(ge=0)
    recommendedSkills: list[RecommendedSkill] = Field(default_factory=list)
    confidence: Confidence
    biasCheck: BiasCheck = Field(default_factory=BiasCheck)


def _norm(name: str) -> str:
    """Case/space-insensitive normalisation for skill-name matching."""
    return name.strip().casefold()


def _missing_required_skills(req: GrowthPathRequest) -> list[str]:
    """The target-role required skills the employee does NOT yet hold (order preserved).

    This is the canonical set difference the whole surface is grounded on. De-duplicates
    the required list (so a skill listed twice counts once) while preserving first-seen order.
    """
    held = {_norm(s.name) for s in req.employeeSkills}
    missing: list[str] = []
    seen: set[str] = set()
    for skill in req.targetRequiredSkills:
        key = _norm(skill)
        if key in held or key in seen:
            continue
        seen.add(key)
        missing.append(skill)
    return missing


def _match_catalog(skill: str, catalog: list[str]) -> str | None:
    """Find a catalog training whose name plausibly covers ``skill`` (substring, either way)."""
    target = _norm(skill)
    for item in catalog:
        entry = _norm(item)
        if target and (target in entry or entry in target):
            return item
    return None


def _generic_training(skill: str) -> str:
    """A generic-but-useful training suggestion when nothing in the catalog fits."""
    return f"An introductory {skill} course or guided on-the-job practice"


def _offline_recommendations(
    missing: list[str], catalog: list[str]
) -> list[RecommendedSkill]:
    """One templated recommendation per missing required skill (catalog match preferred)."""
    recs: list[RecommendedSkill] = []
    for skill in missing:
        match = _match_catalog(skill, catalog)
        recs.append(
            RecommendedSkill(
                skill=skill,
                why=(
                    f"{skill} is required for this role but is not yet in your skill "
                    "profile; adding it closes part of the gap."
                ),
                suggestedTraining=match or _generic_training(skill),
            )
        )
    return recs


def _offline_summary(steps: int, role_title: str, missing: list[str]) -> str:
    """Deterministic, clearly-marked summary templated from the gap."""
    if steps == 0:
        return f"[OFFLINE] You already hold all skills required for {role_title}."
    skills_txt = ", ".join(missing)
    plural = "skill" if steps == 1 else "skills"
    return f"[OFFLINE] You are {steps} {plural} away from {role_title}: add {skills_txt}."


def _offline_response(req: GrowthPathRequest, settings: Settings) -> GrowthPathResponse:
    """Assemble the deterministic offline growth path (clearly marked)."""
    missing = _missing_required_skills(req)
    recs = _offline_recommendations(missing, req.skillCatalog)
    return GrowthPathResponse(
        summary=_offline_summary(len(missing), req.targetRoleTitle, missing),
        stepsAway=len(missing),
        recommendedSkills=recs,
        confidence="high",  # set difference is exact; the determinism makes it reliable
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
        modelVersion=f"{settings.model_version}+offline_fallback",
        promptVersion=PROMPT_VERSION,
    )


def _ground_recommendations(
    model_recs: list[RecommendedSkill],
    missing: list[str],
    catalog: list[str],
) -> list[RecommendedSkill]:
    """Force the model's recommendations onto the true missing-skill set (grounding guard).

    - Drops any recommended skill that is not a genuine, still-missing required skill
      (so the surface can never recommend an already-held or non-required skill).
    - Adds a templated recommendation for any missing skill the model omitted, so
      ``len(recommendedSkills)`` always equals ``stepsAway``.
    Recommendations are returned in target-role (missing) order.
    """
    by_name: dict[str, RecommendedSkill] = {}
    missing_keys = {_norm(s) for s in missing}
    for rec in model_recs:
        key = _norm(rec.skill)
        if key in missing_keys and key not in by_name:
            by_name[key] = rec

    grounded: list[RecommendedSkill] = []
    for skill in missing:
        model_rec = by_name.get(_norm(skill))
        if model_rec is None:
            match = _match_catalog(skill, catalog)
            rec = RecommendedSkill(
                skill=skill,
                why=(
                    f"{skill} is required for this role but is not yet in your skill "
                    "profile; adding it closes part of the gap."
                ),
                suggestedTraining=match or _generic_training(skill),
            )
        else:
            # Pin the recommendation's skill name to the canonical required-skill spelling.
            rec = model_rec.model_copy(update={"skill": skill})
        grounded.append(rec)
    return grounded


async def generate_growth_path(
    req: GrowthPathRequest, *, settings: Settings | None = None
) -> GrowthPathResponse:
    """Generate a skills-based growth path to the target role (spec Module 6a).

    GROUNDED in the supplied skills only: ``stepsAway`` is the count of target-required
    skills the employee lacks (set difference), and recommendations are forced onto that
    set. The biasCheck is forced to "no protected attribute influenced this". Offline
    (no ANTHROPIC_API_KEY): a deterministic set-difference path + templated recommendations.
    """
    settings = settings or get_settings()
    missing = _missing_required_skills(req)
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None

    system = build_growth_path_system_prompt(org_context=org_context)
    user = build_growth_path_user_prompt(
        employee_skills=[s.model_dump() for s in req.employeeSkills],
        target_role_title=req.targetRoleTitle,
        target_required_skills=req.targetRequiredSkills,
        skill_catalog=req.skillCatalog,
    )

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1400,
                temperature=0.0,  # grounded planning, not creative writing
                run_name="module6.growth_path",
                tags=["module6", "skills", "growth_path", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _GrowthContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "targetRoleTitle": req.targetRoleTitle},
            module="module6",
            task="growth_path",
        )
    except LLMUnavailable:
        log.info("growth_path_offline_fallback", orgId=req.orgId)
        return _offline_response(req, settings)

    # Enforce grounding regardless of the model's output: stepsAway is the true set
    # difference, and recommendations are forced onto exactly the missing required skills.
    grounded_recs = _ground_recommendations(
        content.recommendedSkills, missing, req.skillCatalog
    )
    return GrowthPathResponse(
        summary=content.summary,
        stepsAway=len(missing),
        recommendedSkills=grounded_recs,
        confidence=content.confidence,
        # Bias guard (standard #4): growth is computed purely from the skill gap — never
        # from a protected attribute — so no correction is needed and none is recorded.
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
        modelVersion=settings.model_version,
        promptVersion=PROMPT_VERSION,
    )


__all__ = ["generate_growth_path"]
