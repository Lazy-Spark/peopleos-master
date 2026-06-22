"""Module 6c — "Build vs Buy" recommender over the org-wide skill inventory.

LLM path (prompt standards #1/#2/#5/#6/#7): build the XML-tagged system prompt (optionally
personalised with orgContext), pass the skill with its currentSupply / demand /
trainableInternally counts, call Claude, and validate the JSON against an internal Pydantic
model with the shared retry / human-review path.

GROUNDING is enforced, not merely instructed: the deterministic decision rule is the source
of truth for the ``recommendation`` (BUILD / BUY / HYBRID). The LLM is used for the
human-readable ``rationale`` only; if the model's recommendation disagrees with the rule we
override it with the rule's verdict (and keep the model's prose). This makes the verdict
reproducible and auditable.

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): the same deterministic rule + a templated,
clearly-marked rationale. modelVersion is then suffixed ``+offline_fallback``.

Decision rule:
  gap = max(0, demand - currentSupply)
  - gap == 0                                  -> BUILD  (no shortfall; deepen the bench)
  - gap > 0 and trainableInternally >= gap    -> BUILD  (internal pool can close the gap)
  - gap > 0 and trainableInternally == 0      -> BUY    (no internal pool to train)
  - otherwise (0 < trainableInternally < gap) -> HYBRID (train some, hire the remainder)
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.build_vs_buy import (
    PROMPT_VERSION,
    build_build_vs_buy_system_prompt,
    build_build_vs_buy_user_prompt,
)
from ..schemas import (
    BuildVsBuyRecommendation,
    BuildVsBuyRequest,
    BuildVsBuyResponse,
)
from ..validation import validate_or_review

log = structlog.get_logger(__name__)


class _BuildVsBuyContent(BaseModel):
    """Internal validation model for the model's JSON (the content only).

    ``modelVersion``/``promptVersion`` are stamped on by this module, so this is a lean
    subset of ``BuildVsBuyResponse``.
    """

    recommendation: BuildVsBuyRecommendation
    rationale: str


def decide(
    *, current_supply: int, demand: int, trainable_internally: int
) -> tuple[BuildVsBuyRecommendation, int]:
    """The deterministic build-vs-buy verdict + the computed gap (source of truth)."""
    gap = max(0, demand - current_supply)
    if gap == 0:
        return "BUILD", gap
    if trainable_internally >= gap:
        return "BUILD", gap
    if trainable_internally == 0:
        return "BUY", gap
    return "HYBRID", gap


def _templated_rationale(
    *,
    skill: str,
    current_supply: int,
    demand: int,
    trainable_internally: int,
    recommendation: BuildVsBuyRecommendation,
    gap: int,
) -> str:
    """A deterministic, clearly-marked rationale grounded in the supplied numbers."""
    base = (
        f"[OFFLINE] Demand of {demand} against a supply of {current_supply} for {skill} "
        f"leaves a gap of {gap}"
    )
    if gap == 0:
        return (
            f"[OFFLINE] Supply of {current_supply} already meets the demand of {demand} "
            f"for {skill}, so there is no hiring shortfall — invest in deepening the "
            "existing bench rather than hiring."
        )
    if recommendation == "BUILD":
        return (
            f"{base}, and {trainable_internally} current employee(s) are trainable into "
            "it. The internal pool can fully close the gap, so train rather than hire."
        )
    if recommendation == "BUY":
        return (
            f"{base}, and no current employees are close enough to train. With no internal "
            "pool to develop, hire externally to close the gap."
        )
    remainder = gap - trainable_internally
    return (
        f"{base}, but only {trainable_internally} employee(s) are trainable into it. Train "
        f"those {trainable_internally} and hire the remaining ~{remainder} externally."
    )


def _offline_response(req: BuildVsBuyRequest, settings: Settings) -> BuildVsBuyResponse:
    """Assemble the deterministic offline build-vs-buy response (clearly marked)."""
    recommendation, gap = decide(
        current_supply=req.currentSupply,
        demand=req.demand,
        trainable_internally=req.trainableInternally,
    )
    return BuildVsBuyResponse(
        recommendation=recommendation,
        rationale=_templated_rationale(
            skill=req.skill,
            current_supply=req.currentSupply,
            demand=req.demand,
            trainable_internally=req.trainableInternally,
            recommendation=recommendation,
            gap=gap,
        ),
        modelVersion=f"{settings.model_version}+offline_fallback",
        promptVersion=PROMPT_VERSION,
    )


async def recommend_build_vs_buy(
    req: BuildVsBuyRequest, *, settings: Settings | None = None
) -> BuildVsBuyResponse:
    """Recommend BUILD / BUY / HYBRID for a skill gap (spec Module 6c).

    The recommendation is the deterministic rule's verdict (reproducible / auditable); the
    LLM supplies the human-readable rationale. If the model disagrees with the rule the
    rule wins. Offline (no ANTHROPIC_API_KEY): the rule + a templated rationale.
    """
    settings = settings or get_settings()
    rule_recommendation, gap = decide(
        current_supply=req.currentSupply,
        demand=req.demand,
        trainable_internally=req.trainableInternally,
    )
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None

    system = build_build_vs_buy_system_prompt(org_context=org_context)
    user = build_build_vs_buy_user_prompt(
        skill=req.skill,
        current_supply=req.currentSupply,
        demand=req.demand,
        trainable_internally=req.trainableInternally,
    )

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=600,
                temperature=0.0,  # rule-grounded advice, not creative
                run_name="module6.build_vs_buy",
                tags=["module6", "skills", "build_vs_buy", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _BuildVsBuyContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "skill": req.skill},
            module="module6",
            task="build_vs_buy",
        )
    except LLMUnavailable:
        log.info("build_vs_buy_offline_fallback", orgId=req.orgId)
        return _offline_response(req, settings)

    # Enforce the deterministic rule as the source of truth: the verdict is reproducible
    # and auditable. If the model disagreed, override the verdict but keep its prose.
    recommendation = rule_recommendation
    rationale = content.rationale
    if content.recommendation != rule_recommendation:
        log.warning(
            "build_vs_buy_model_disagreed_overridden",
            orgId=req.orgId,
            modelRecommendation=content.recommendation,
            ruleRecommendation=rule_recommendation,
        )
        rationale = (
            f"{rationale} (Recommendation set to {rule_recommendation} by the "
            f"supply/demand rule: gap of {gap} vs {req.trainableInternally} trainable.)"
        )

    return BuildVsBuyResponse(
        recommendation=recommendation,
        rationale=rationale,
        modelVersion=settings.model_version,
        promptVersion=PROMPT_VERSION,
    )


__all__ = ["decide", "recommend_build_vs_buy"]
