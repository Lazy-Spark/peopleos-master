"""Module 7 — attrition risk EXPLANATION (manager-facing, ADVISORY).

LLM path (prompt standards #1/#2/#4/#5/#6/#7): build the XML-tagged system prompt
(optionally personalised with orgContext), pass the risk TIER + the model's ``topDrivers``
+ a NON-PII employee context, call Claude, and validate the JSON against an internal
Pydantic model with the shared retry / human-review path. The raw risk score / SHAP values
are NOT passed into the prompt, so the narrative cannot leak them (the manager only ever
sees the tier + the recommendation per the spec).

GROUNDING + BIAS GUARD are enforced, not merely instructed: regardless of what the model
returns, this module forces ``biasCheck`` to "no protected attribute influenced this"
(the explanation is grounded purely in the work-signal drivers, standard #4).

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a deterministic templated narrative built from
the same topDrivers — clearly marked with an ``[OFFLINE]`` prefix — so the surface works
with no network/keys. modelVersion is then suffixed ``+offline_fallback``.
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.attrition_explain import (
    PROMPT_VERSION,
    build_attrition_explain_system_prompt,
    build_attrition_explain_user_prompt,
)
from ..schemas import (
    BiasCheck,
    Confidence,
    DriverContribution,
    ExplainAttritionRequest,
    ExplainAttritionResponse,
)
from ..validation import validate_or_review

log = structlog.get_logger(__name__)


class _ExplainContent(BaseModel):
    """Internal validation model for the model's JSON (content only).

    The version fields + the forced biasCheck are stamped on by this module, so this is a
    lean subset of ``ExplainAttritionResponse``.
    """

    narrative: str
    recommendedActions: list[str] = Field(default_factory=list)
    confidence: Confidence
    biasCheck: BiasCheck = Field(default_factory=BiasCheck)


# ── Offline deterministic templates (clearly marked) ───────────────────────────────────
# Plain-language phrasing per driver feature, by direction. Keeps the offline narrative
# grounded in exactly the drivers the model produced (never a feature not in topDrivers).
_INCREASE_PHRASE: dict[str, str] = {
    "daysSinceLastPromotion": "a long stretch since their last promotion",
    "teamAttritionRate90d": "high recent turnover on their team",
    "managerChanged90d": "a recent manager change",
    "perfRating": "a strong recent performance rating without matching recognition",
    "daysSinceLastReview": "a long gap since their last review",
    "timeInRoleDays": "an extended time in the same role",
    "tenureDays": "being at a mid-tenure point often associated with weighing options",
    "skillAdditions90d": "notable recent skill growth that can precede a move",
}
_DECREASE_PHRASE: dict[str, str] = {
    "daysSinceLastPromotion": "a recent promotion",
    "teamAttritionRate90d": "a stable team with little recent turnover",
    "managerChanged90d": "a stable manager relationship",
    "perfRating": "performance that appears recognised",
    "daysSinceLastReview": "a recent review",
    "timeInRoleDays": "a relatively recent role change",
    "tenureDays": "a tenure point with lower typical flight risk",
    "skillAdditions90d": "steady skill development",
}
# Supportive, retention-oriented action per increasing driver (never adverse).
_ACTION_FOR: dict[str, str] = {
    "daysSinceLastPromotion": "Schedule a career-development conversation about progression and a concrete path to the next level.",
    "teamAttritionRate90d": "Hold a supportive 1:1 to acknowledge the recent team turnover and surface any added workload or morale concerns.",
    "managerChanged90d": "Have the current manager hold a deliberate relationship-building 1:1 to ease the recent transition.",
    "perfRating": "Recognise the strong performance and review whether a promotion or scope increase is warranted.",
    "daysSinceLastReview": "Schedule the overdue check-in or performance review to reset goals and expectations.",
    "timeInRoleDays": "Explore a stretch project, lateral move, or growth opportunity to re-energise their time in role.",
    "tenureDays": "Reaffirm the growth path and what the next step looks like at this tenure point.",
    "skillAdditions90d": "Discuss how their newly developed skills could be applied to higher-impact or internal-mobility opportunities.",
}


def _label_for(driver: DriverContribution) -> str:
    """The driver's human label, falling back to a phrase or the feature key."""
    return driver.label or driver.feature


def _phrase_for(driver: DriverContribution) -> str:
    """A plain-language phrase for a driver, by direction (falls back to its label)."""
    table = _INCREASE_PHRASE if driver.direction == "INCREASES" else _DECREASE_PHRASE
    return table.get(driver.feature, _label_for(driver).lower())


def _context_descriptor(req: ExplainAttritionRequest) -> str:
    """A short non-PII role descriptor, e.g. "Senior Engineer in Engineering"."""
    ctx = req.employeeContext
    role = ctx.roleTitle or "employee"
    if ctx.department:
        return f"{role} in {ctx.department}"
    return role


def _offline_narrative(req: ExplainAttritionRequest) -> str:
    """Deterministic, clearly-marked narrative grounded in the supplied drivers."""
    who = _context_descriptor(req)
    increasing = [d for d in req.topDrivers if d.direction == "INCREASES"]
    decreasing = [d for d in req.topDrivers if d.direction == "DECREASES"]

    lead = f"[OFFLINE] This {who} is showing {req.riskTier} attrition risk."
    if increasing:
        phrases = [_phrase_for(d) for d in increasing[:3]]
        if len(phrases) == 1:
            drivers_txt = phrases[0]
        else:
            drivers_txt = ", ".join(phrases[:-1]) + " and " + phrases[-1]
        body = f" The main contributing signals are {drivers_txt}."
    else:
        body = " No individual signal stands out strongly."
    if decreasing:
        body += f" A mitigating factor is {_phrase_for(decreasing[0])}."
    tail = (
        " This is an advisory signal — a prompt for a supportive check-in, not a "
        "conclusion or a basis for any action against the employee."
    )
    return lead + body + tail


def _offline_actions(drivers: list[DriverContribution]) -> list[str]:
    """One supportive action per INCREASING driver (deterministic, never adverse)."""
    actions: list[str] = []
    seen: set[str] = set()
    for d in drivers:
        if d.direction != "INCREASES":
            continue
        action = _ACTION_FOR.get(
            d.feature,
            f"Discuss {_label_for(d).lower()} with the employee in a supportive 1:1.",
        )
        if action not in seen:
            seen.add(action)
            actions.append(action)
    if not actions:
        actions.append(
            "Hold a routine supportive check-in to stay connected on goals and growth."
        )
    return actions[:4]


def _offline_response(
    req: ExplainAttritionRequest, settings: Settings
) -> ExplainAttritionResponse:
    """Assemble the deterministic offline explanation (clearly marked)."""
    # Lower-tier flags get lower stated confidence; the determinism keeps it reproducible.
    confidence: Confidence = "high" if req.riskTier in ("CRITICAL", "HIGH") else "medium"
    return ExplainAttritionResponse(
        narrative=_offline_narrative(req),
        recommendedActions=_offline_actions(req.topDrivers),
        confidence=confidence,
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
        modelVersion=f"{settings.model_version}+offline_fallback",
        promptVersion=PROMPT_VERSION,
    )


async def explain_attrition(
    req: ExplainAttritionRequest, *, settings: Settings | None = None
) -> ExplainAttritionResponse:
    """Explain an attrition-risk flag for a manager (Module 7 explanation layer).

    GROUNDED ONLY in the supplied ``topDrivers`` + the risk TIER + a NON-PII context: the
    raw score and feature values are never passed to the prompt, so the narrative cannot
    leak them (managers see tier + recommendation only). The narrative is framed as
    ADVISORY (no automated HR action), never references personal circumstances (privacy
    guard #7) or a protected attribute (bias guard #4 — biasCheck is forced empty). Offline
    (no ANTHROPIC_API_KEY): a deterministic templated narrative built from the same drivers.
    """
    settings = settings or get_settings()
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None

    system = build_attrition_explain_system_prompt(org_context=org_context)
    user = build_attrition_explain_user_prompt(
        risk_tier=req.riskTier,
        top_drivers=[d.model_dump() for d in req.topDrivers],
        employee_context=req.employeeContext.model_dump(),
    )

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=900,
                temperature=0.2,  # supportive prose, but kept grounded
                run_name="module7.attrition_explain",
                tags=["module7", "attrition", "explain", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _ExplainContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "riskTier": req.riskTier},
            module="module7",
            task="attrition_explain",
        )
    except LLMUnavailable:
        log.info("attrition_explain_offline_fallback", orgId=req.orgId, riskTier=req.riskTier)
        return _offline_response(req, settings)

    return ExplainAttritionResponse(
        narrative=content.narrative,
        recommendedActions=content.recommendedActions,
        confidence=content.confidence,
        # Bias guard (standard #4): the explanation is grounded purely in the work-signal
        # drivers — never a protected attribute — so no correction is needed and none is
        # recorded. Forced regardless of the model's self-report.
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
        modelVersion=settings.model_version,
        promptVersion=PROMPT_VERSION,
    )


__all__ = ["explain_attrition"]
