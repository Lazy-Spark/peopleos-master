"""Module 5e — AI workforce-analytics narrative + anomaly detection.

LLM path (prompt standards #1/#2/#5/#6): build the XML-tagged system prompt (optionally
personalised with orgContext), pass the metrics snapshot, call Claude, and validate the
JSON against an internal Pydantic model with the shared retry/human-review path. Every
number is grounded ONLY in the supplied metrics — the prompt forbids inventing or
extrapolating, and the model never queries data or writes SQL.

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a clearly-marked deterministic narrative
templated from the metrics, PLUS rule-based anomaly detection (span-of-control flags,
SLA breaches, stage conversion < ~0.3, low offer-acceptance, low new-hire success,
promotion bottlenecks). modelVersion is then suffixed ``+offline_fallback``.

The metrics arrive as an opaque dict (the API already validated it against the strict Zod
``DashboardMetrics``); ``app.analytics.metrics_access`` provides safe navigation helpers
so a missing/null field never raises.
"""

from __future__ import annotations

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.analytics_narrative import (
    PROMPT_VERSION,
    build_narrative_system_prompt,
    build_narrative_user_prompt,
)
from ..schemas import (
    AnalyticsNarrativeRequest,
    AnalyticsNarrativeResponse,
    Anomaly,
    NarrativeMetric,
)
from ..validation import validate_or_review
from .metrics_access import (
    detect_anomalies,
    fmt_count,
    fmt_days,
    fmt_pct,
    get_path,
)

log = structlog.get_logger(__name__)


class _NarrativeContent(BaseModel):
    """Internal validation model for the model's JSON (the content only).

    The version fields are stamped on by this module — the model does not produce them —
    so this is a lean subset of ``AnalyticsNarrativeResponse``.
    """

    headline: str
    narrative: str
    keyMetrics: list[NarrativeMetric] = Field(default_factory=list)
    anomalies: list[Anomaly] = Field(default_factory=list)


def _offline_key_metrics(metrics: dict[str, object]) -> list[NarrativeMetric]:
    """The most important metrics, formatted for humans, drawn from the snapshot."""
    out: list[NarrativeMetric] = []

    open_roles = get_path(metrics, "recruiting.openRoles")
    ttf = get_path(metrics, "recruiting.timeToFillDays")
    if open_roles is not None:
        out.append(
            NarrativeMetric(
                label="Open roles",
                value=fmt_count(open_roles),
                note=(f"avg {fmt_days(ttf)} to fill" if ttf is not None else None),
            )
        )

    breaches = get_path(metrics, "recruiting.slaBreaches")
    if isinstance(breaches, list):
        titles = ", ".join(
            str(b.get("title")) for b in breaches[:3] if isinstance(b, dict) and b.get("title")
        )
        out.append(
            NarrativeMetric(
                label="SLA breaches",
                value=fmt_count(len(breaches)),
                note=(titles or None),
            )
        )

    oar = get_path(metrics, "recruiting.offerAcceptanceRate")
    if oar is not None:
        out.append(
            NarrativeMetric(label="Offer acceptance", value=fmt_pct(oar), note=None)
        )

    headcount = get_path(metrics, "workforce.totalHeadcount")
    if headcount is not None:
        out.append(
            NarrativeMetric(label="Total headcount", value=fmt_count(headcount), note=None)
        )

    nhs = get_path(metrics, "workforce.newHireSuccessRate")
    if nhs is not None:
        out.append(
            NarrativeMetric(
                label="New-hire success",
                value=fmt_pct(nhs),
                note="90-day mark with good perf",
            )
        )
    return out[:6]


def _offline_narrative(metrics: dict[str, object]) -> tuple[str, str]:
    """Deterministic (headline, 3-paragraph narrative) templated from the metrics.

    Clearly marked ``[OFFLINE SUMMARY]`` so it is never mistaken for an LLM narrative.
    """
    open_roles = get_path(metrics, "recruiting.openRoles")
    ttf = get_path(metrics, "recruiting.timeToFillDays")
    oar = get_path(metrics, "recruiting.offerAcceptanceRate")
    breaches = get_path(metrics, "recruiting.slaBreaches")
    n_breaches = len(breaches) if isinstance(breaches, list) else 0
    headcount = get_path(metrics, "workforce.totalHeadcount")
    nhs = get_path(metrics, "workforce.newHireSuccessRate")
    eng_available = bool(get_path(metrics, "engagement.available"))
    skills_available = bool(get_path(metrics, "skills.available"))

    # Paragraph 1 — recruiting velocity / funnel.
    p1_bits: list[str] = ["[OFFLINE SUMMARY] Recruiting snapshot:"]
    if open_roles is not None:
        roles_clause = f"{fmt_count(open_roles)} open role(s)"
        if ttf is not None:
            roles_clause += f" at an average {fmt_days(ttf)} to fill"
        p1_bits.append(roles_clause + ".")
    if oar is not None:
        p1_bits.append(f"Offer-acceptance rate is {fmt_pct(oar)}.")
    if n_breaches:
        p1_bits.append(f"{fmt_count(n_breaches)} role(s) have breached SLA and need attention.")
    elif breaches is not None:
        p1_bits.append("No roles are past SLA.")
    p1 = " ".join(p1_bits)

    # Paragraph 2 — workforce structure / selection quality.
    p2_bits: list[str] = ["Workforce:"]
    if headcount is not None:
        p2_bits.append(f"{fmt_count(headcount)} employees in total.")
    if nhs is not None:
        p2_bits.append(f"New-hire success is {fmt_pct(nhs)} at the 90-day mark.")
    spans = get_path(metrics, "workforce.spanOfControl")
    if isinstance(spans, list):
        wide = sum(1 for s in spans if isinstance(s, dict) and s.get("flag") == "WIDE")
        narrow = sum(1 for s in spans if isinstance(s, dict) and s.get("flag") == "NARROW")
        if wide or narrow:
            p2_bits.append(
                f"Span-of-control flags: {fmt_count(wide)} WIDE, {fmt_count(narrow)} NARROW."
            )
    p2 = " ".join(p2_bits) if len(p2_bits) > 1 else "Workforce: no composition metrics in this snapshot."

    # Paragraph 3 — engagement + skills availability (degrade gracefully).
    p3_bits: list[str] = []
    if eng_available:
        p3_bits.append("Engagement & retention data is available; review the attrition heatmap.")
    else:
        reason = get_path(metrics, "engagement.pendingReason") or "pending Module 7 / surveys"
        p3_bits.append(f"Engagement & retention analytics are not yet available ({reason}).")
    if skills_available:
        p3_bits.append("Skills & talent-density data is available; review skill gaps.")
    else:
        reason = get_path(metrics, "skills.pendingReason") or "pending the Module 6 skill graph"
        p3_bits.append(f"Skills & talent-density analytics are not yet available ({reason}).")
    p3 = " ".join(p3_bits)

    narrative = f"{p1}\n\n{p2}\n\n{p3}"

    # Headline — surface the single most pressing signal deterministically.
    if n_breaches:
        headline = f"[OFFLINE] {fmt_count(n_breaches)} role(s) past SLA — recruiting velocity is the watch item."
    elif oar is not None and float(oar) < 0.7:
        headline = f"[OFFLINE] Offer acceptance at {fmt_pct(oar)} is the period's soft spot."
    elif headcount is not None:
        headline = f"[OFFLINE] Workforce of {fmt_count(headcount)} with no SLA breaches this period."
    else:
        headline = "[OFFLINE] Deterministic workforce summary (no LLM available)."
    return headline, narrative


def _offline_response(
    req: AnalyticsNarrativeRequest, settings: Settings
) -> AnalyticsNarrativeResponse:
    """Assemble the clearly-marked deterministic offline narrative response."""
    metrics = req.metrics
    headline, narrative = _offline_narrative(metrics)
    return AnalyticsNarrativeResponse(
        headline=headline,
        narrative=narrative,
        keyMetrics=_offline_key_metrics(metrics),
        anomalies=detect_anomalies(metrics),
        modelVersion=f"{settings.model_version}+offline_fallback",
        promptVersion=PROMPT_VERSION,
    )


async def generate_narrative(
    req: AnalyticsNarrativeRequest, *, settings: Settings | None = None
) -> AnalyticsNarrativeResponse:
    """Generate the executive workforce narrative + anomalies (spec Module 5e).

    Grounded ONLY in the supplied metrics. Offline (no ANTHROPIC_API_KEY): a
    clearly-marked deterministic narrative + rule-based anomalies.
    """
    settings = settings or get_settings()
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None

    system = build_narrative_system_prompt(org_context=org_context)
    user = build_narrative_user_prompt(req.metrics)

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1800,
                temperature=0.0,  # grounded narration, not creative writing
                run_name="module5.analytics_narrative",
                tags=["module5", "analytics", "narrative", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _NarrativeContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId},
            module="module5",
            task="analytics_narrative",
        )
    except LLMUnavailable:
        log.info("analytics_narrative_offline_fallback", orgId=req.orgId)
        return _offline_response(req, settings)

    return AnalyticsNarrativeResponse(
        headline=content.headline,
        narrative=content.narrative,
        keyMetrics=content.keyMetrics,
        anomalies=content.anomalies,
        modelVersion=settings.model_version,
        promptVersion=PROMPT_VERSION,
    )


__all__ = ["generate_narrative"]
