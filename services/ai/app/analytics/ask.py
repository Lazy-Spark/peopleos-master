"""Module 5e — "Ask your data" NL Q&A over the metrics snapshot.

LLM path (prompt standards #1/#2/#5/#6): build the XML-tagged system prompt, pass the
question + the metrics snapshot, call Claude, and validate the JSON against an internal
Pydantic model with the shared retry/human-review path. The answer is grounded ONLY in the
snapshot — the prompt forbids inventing numbers and forbids SQL; if the needed metric is
absent the model says so and sets confidence "low".

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a deterministic keyword -> metric lookup over the
metrics dict (``metrics_access.lookup_answer``) with a templated answer (clearly marked)
and an optional chart built from the matched metric. modelVersion is then suffixed
``+offline_fallback``.
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.analytics_ask import (
    PROMPT_VERSION,
    build_ask_system_prompt,
    build_ask_user_prompt,
)
from ..schemas import (
    AskDataRequest,
    AskDataResponse,
    ChartSpec,
    Confidence,
)
from ..validation import validate_or_review
from .metrics_access import lookup_answer

log = structlog.get_logger(__name__)


class _AskContent(BaseModel):
    """Internal validation model for the model's JSON (the content only).

    ``modelVersion`` is stamped on by this module, so this is a lean subset of
    ``AskDataResponse``.
    """

    answer: str
    usedMetrics: list[str] = Field(default_factory=list)
    chart: ChartSpec | None = None
    confidence: Confidence


def _offline_response(req: AskDataRequest, settings: Settings) -> AskDataResponse:
    """Deterministic offline answer via keyword -> metric lookup (clearly marked)."""
    answer, used, chart, confidence = lookup_answer(req.question, req.metrics)
    # Mark the templated answer unless the lookup already prefixed it (the no-match case).
    if not answer.startswith("[OFFLINE]"):
        answer = f"[OFFLINE] {answer}"
    return AskDataResponse(
        answer=answer,
        usedMetrics=used,
        chart=chart,
        confidence=confidence,  # type: ignore[arg-type]
        modelVersion=f"{settings.model_version}+offline_fallback",
    )


async def answer_data_question(
    req: AskDataRequest, *, settings: Settings | None = None
) -> AskDataResponse:
    """Answer a NL question grounded ONLY in the supplied metrics (spec Module 5e).

    Offline (no ANTHROPIC_API_KEY): a deterministic keyword -> metric lookup; if the
    metric is absent it says so plainly and sets confidence "low".
    """
    settings = settings or get_settings()
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None

    system = build_ask_system_prompt(org_context=org_context)
    user = build_ask_user_prompt(req.question, req.metrics)

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1200,
                temperature=0.0,  # grounded retrieval over the snapshot, not creative
                run_name="module5.analytics_ask",
                tags=["module5", "analytics", "ask", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _AskContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "question": req.question},
            module="module5",
            task="analytics_ask",
        )
    except LLMUnavailable:
        log.info("analytics_ask_offline_fallback", orgId=req.orgId)
        return _offline_response(req, settings)

    # Enforce chart grounding: a model-produced ChartSpec series value must match a real
    # number in the metrics snapshot (within tolerance for rounding). A fabricated value
    # drops the chart + downgrades confidence — the "series from real values" guarantee,
    # ENFORCED rather than merely instructed.
    grounded_chart = _ground_chart(content.chart, req.metrics)
    confidence = content.confidence
    if content.chart is not None and grounded_chart is None:
        log.warning("analytics_ask_chart_ungrounded_dropped", orgId=req.orgId)
        if confidence == "high":
            confidence = "medium"

    return AskDataResponse(
        answer=content.answer,
        usedMetrics=content.usedMetrics,
        chart=grounded_chart,
        confidence=confidence,
        modelVersion=settings.model_version,
    )


def _collect_numbers(obj: object, acc: set[float]) -> None:
    """Recursively gather every numeric value reachable in the metrics snapshot."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        acc.add(round(float(obj), 4))
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_numbers(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            _collect_numbers(v, acc)


def _ground_chart(chart: ChartSpec | None, metrics: dict[str, object]) -> ChartSpec | None:
    """Return the chart only if EVERY series value matches a real snapshot number (within a
    small tolerance for model rounding); otherwise None (drop the fabricated chart)."""
    if chart is None:
        return None
    nums: set[float] = set()
    _collect_numbers(metrics, nums)
    for pt in chart.series:
        v = float(pt.value)
        if not any(abs(v - n) <= max(0.01, abs(n) * 0.02) for n in nums):
            return None
    return chart


__all__ = ["answer_data_question"]
