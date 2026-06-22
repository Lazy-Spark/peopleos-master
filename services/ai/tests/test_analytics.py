"""Unit tests for Module 5e — Workforce Analytics Dashboard AI surfaces.

All tests run WITHOUT network:
  - the offline path (no ANTHROPIC_API_KEY) exercises the deterministic narrative +
    rule-based anomalies and the keyword -> metric "Ask your data" lookup,
  - the LLM path is exercised by monkeypatching ``call_llm`` so we assert the grounding
    plumbing (the snapshot reaches the prompt; valid JSON is parsed) with no network.

The metrics snapshot is an opaque dict here (the API has already validated it against the
strict Zod DashboardMetrics); the fixtures mirror that wire shape (camelCase).
"""

from __future__ import annotations

import json

import pytest
from app.analytics import answer_data_question, generate_narrative
from app.analytics.metrics_access import detect_anomalies, get_path, lookup_answer
from app.config import Settings
from app.schemas import AnalyticsNarrativeRequest, AskDataRequest

_ORG = "00000000-0000-0000-0000-000000000001"


def _offline_settings() -> Settings:
    """Settings with no Anthropic key — forces the deterministic offline fallback."""
    return Settings(anthropic_api_key=None)


def _online_settings() -> Settings:
    """Settings with a (fake) key so the surfaces take the LLM path; call_llm is stubbed."""
    return Settings(anthropic_api_key="sk-test-not-real")


def _metrics(**overrides: object) -> dict[str, object]:
    """A representative DashboardMetrics-shaped snapshot (camelCase wire shape)."""
    base: dict[str, object] = {
        "orgId": _ORG,
        "generatedAt": "2026-06-19T00:00:00.000Z",
        "recruiting": {
            "byStage": [{"stage": "APPLIED", "count": 120}],
            "conversionRates": [
                {"from": "SCREEN", "to": "INTERVIEW", "rate": 0.22},
            ],
            "totalApplications": 120,
            "openRoles": 12,
            "timeToFillDays": 61,
            "timeToHireDays": 28,
            "offerAcceptanceRate": 0.58,
            "sourceOfHire": [
                {"source": "LINKEDIN", "count": 8},
                {"source": "REFERRAL", "count": 5},
            ],
            "slaBreaches": [
                {"jobId": "11111111-1111-1111-1111-111111111111", "title": "Staff SRE", "daysOpen": 74},
            ],
        },
        "workforce": {
            "totalHeadcount": 340,
            "byDepartment": [
                {"key": "Engineering", "count": 142},
                {"key": "Sales", "count": 61},
            ],
            "byLocation": [
                {"key": "US", "count": 200},
                {"key": "Europe", "count": 140},
            ],
            "byLevel": [{"key": "SENIOR", "count": 80}],
            "byEmploymentType": [{"key": "FULL_TIME", "count": 320}],
            "spanOfControl": [
                {
                    "managerId": "22222222-2222-2222-2222-222222222222",
                    "managerName": "A. Rivera",
                    "directReports": 11,
                    "flag": "WIDE",
                },
                {
                    "managerId": "33333333-3333-3333-3333-333333333333",
                    "managerName": "L. Chen",
                    "directReports": 2,
                    "flag": "NARROW",
                },
            ],
            "promotionRateByLevel": [
                {"level": "SENIOR", "promoted": 0, "total": 14, "rate": 0.0},
            ],
            "newHireSuccessRate": 0.71,
            "internalMobilityRate": 0.4,
        },
        "engagement": {
            "available": False,
            "pendingReason": "Module 7 attrition scores not yet available",
            "attritionByTier": [],
            "attritionHeatmap": [],
            "regrettableCount": 0,
            "enpsTrend": [],
        },
        "skills": {
            "available": False,
            "pendingReason": "Module 6 skill graph not yet available",
            "skillGaps": [],
            "busFactorRisks": [],
            "talentDensityIndex": None,
        },
    }
    base.update(overrides)
    return base


# ═══ Narrative — offline grounding + span anomaly ═════════════════════════════════
@pytest.mark.asyncio
async def test_narrative_offline_grounds_in_metrics() -> None:
    """The offline narrative is deterministic, clearly marked, and uses real numbers."""
    req = AnalyticsNarrativeRequest(orgId=_ORG, metrics=_metrics())
    resp = await generate_narrative(req, settings=_offline_settings())

    # Clearly-marked offline output.
    assert "+offline_fallback" in resp.modelVersion
    assert "[OFFLINE" in resp.headline
    assert "[OFFLINE SUMMARY]" in resp.narrative

    # Exactly 3 paragraphs.
    assert len([p for p in resp.narrative.split("\n\n") if p.strip()]) == 3

    # GROUNDED: numbers in the output come from the snapshot, none invented.
    assert "61 days" in resp.narrative  # timeToFillDays
    assert "58%" in resp.narrative  # offerAcceptanceRate
    assert "340" in resp.narrative  # totalHeadcount

    # keyMetrics are drawn from the snapshot.
    labels = {m.label for m in resp.keyMetrics}
    assert "Open roles" in labels
    assert "Total headcount" in labels
    values = {m.label: m.value for m in resp.keyMetrics}
    assert values["Open roles"] == "12"
    assert values["Total headcount"] == "340"

    # Engagement + skills degrade gracefully (not reported as real zeros).
    assert "not yet available" in resp.narrative


@pytest.mark.asyncio
async def test_narrative_offline_flags_wide_and_narrow_span() -> None:
    """Offline anomalies flag the WIDE and NARROW span-of-control rows (spec 5b/5e)."""
    req = AnalyticsNarrativeRequest(orgId=_ORG, metrics=_metrics())
    resp = await generate_narrative(req, settings=_offline_settings())

    span_anoms = [a for a in resp.anomalies if a.metric == "workforce.spanOfControl"]
    details = " ".join(a.detail for a in span_anoms)
    assert "WIDE" in details
    assert "A. Rivera" in details
    assert "NARROW" in details
    assert "L. Chen" in details

    severities = {a.detail.split()[0] if False else a.severity for a in span_anoms}
    # WIDE -> MEDIUM, NARROW -> LOW (matches the prompt's guidance for consistency).
    assert "MEDIUM" in severities
    assert "LOW" in severities


def test_detect_anomalies_covers_sla_conversion_and_promotion() -> None:
    """The rule-based detector flags SLA breaches, low conversion, and 0% promotion."""
    anoms = detect_anomalies(_metrics())
    by_metric = {a.metric for a in anoms}
    assert "recruiting.slaBreaches" in by_metric
    assert "recruiting.conversionRates" in by_metric  # 0.22 < 0.30
    assert "recruiting.offerAcceptanceRate" in by_metric  # 0.58 < 0.70
    assert "workforce.promotionRateByLevel" in by_metric  # 0 of 14

    sla = next(a for a in anoms if a.metric == "recruiting.slaBreaches")
    assert sla.severity == "HIGH"
    assert "Staff SRE" in sla.detail


def test_detect_anomalies_quiet_when_healthy() -> None:
    """A healthy snapshot produces no false anomalies (no fabricated flags)."""
    healthy = _metrics(
        recruiting={
            "byStage": [],
            "conversionRates": [{"from": "SCREEN", "to": "INTERVIEW", "rate": 0.5}],
            "totalApplications": 30,
            "openRoles": 3,
            "timeToFillDays": 30,
            "timeToHireDays": 20,
            "offerAcceptanceRate": 0.92,
            "sourceOfHire": [],
            "slaBreaches": [],
        },
        workforce={
            "totalHeadcount": 58,
            "byDepartment": [],
            "byLocation": [],
            "byLevel": [],
            "byEmploymentType": [],
            "spanOfControl": [
                {
                    "managerId": "44444444-4444-4444-4444-444444444444",
                    "managerName": "OK Mgr",
                    "directReports": 5,
                    "flag": "OK",
                }
            ],
            "promotionRateByLevel": [{"level": "MID", "promoted": 3, "total": 10, "rate": 0.3}],
            "newHireSuccessRate": 0.95,
            "internalMobilityRate": 0.5,
        },
    )
    assert detect_anomalies(healthy) == []


# ═══ Ask your data — offline answers from a metric + chart, and absence handling ═══
@pytest.mark.asyncio
async def test_ask_offline_answers_from_metric_with_chart() -> None:
    """A department question is answered from the snapshot and returns a BAR chart."""
    req = AskDataRequest(
        orgId=_ORG,
        question="How many people work in each department?",
        metrics=_metrics(),
    )
    resp = await answer_data_question(req, settings=_offline_settings())

    assert "+offline_fallback" in resp.modelVersion
    assert resp.confidence == "high"
    assert "workforce.byDepartment" in resp.usedMetrics
    # Answer uses the real numbers from the snapshot.
    assert "Engineering: 142" in resp.answer
    # A chart aids this breakdown.
    assert resp.chart is not None
    assert resp.chart.type == "BAR"
    series = {p.label: p.value for p in resp.chart.series}
    assert series["Engineering"] == 142
    assert series["Sales"] == 61


@pytest.mark.asyncio
async def test_ask_offline_answers_scalar_offer_acceptance() -> None:
    """A scalar question is answered from the metric with no chart."""
    req = AskDataRequest(
        orgId=_ORG, question="What is our offer acceptance rate?", metrics=_metrics()
    )
    resp = await answer_data_question(req, settings=_offline_settings())
    assert "recruiting.offerAcceptanceRate" in resp.usedMetrics
    assert "58%" in resp.answer
    assert resp.chart is None
    assert resp.confidence == "high"


@pytest.mark.asyncio
async def test_ask_offline_says_not_available_for_absent_metric() -> None:
    """A cross-tab the snapshot doesn't compute -> 'not available' + low confidence."""
    req = AskDataRequest(
        orgId=_ORG,
        question="What is our average tenure in years?",  # no tenure metric in the snapshot
        metrics=_metrics(),
    )
    resp = await answer_data_question(req, settings=_offline_settings())
    assert resp.confidence == "low"
    assert resp.usedMetrics == []
    assert resp.chart is None
    assert "can't answer" in resp.answer.lower()


def test_lookup_answer_absent_metric_when_section_empty() -> None:
    """When the matched section is missing, the lookup degrades to low confidence."""
    # Department keyword present, but no byDepartment data -> not answerable.
    metrics = _metrics(
        workforce={"totalHeadcount": 10, "spanOfControl": [], "byDepartment": []}
    )
    answer, used, chart, confidence = lookup_answer("how many engineers?", metrics)
    assert confidence == "low"
    assert used == []
    assert chart is None


def test_get_path_safe_navigation() -> None:
    """get_path never raises on missing/null segments."""
    m = _metrics()
    assert get_path(m, "recruiting.openRoles") == 12
    assert get_path(m, "recruiting.nope") is None
    assert get_path(m, "nope.deep.path") is None
    assert get_path(m, "skills.talentDensityIndex") is None  # explicit null


# ═══ LLM path — grounding plumbing (call_llm stubbed; no network) ═════════════════
@pytest.mark.asyncio
async def test_narrative_llm_path_parses_and_grounds(monkeypatch: pytest.MonkeyPatch) -> None:
    """With a key set, the surface calls the LLM, the snapshot reaches the prompt, and a
    valid JSON response is parsed into the contract (no +offline_fallback marker)."""
    seen: dict[str, str] = {}

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        # The metrics snapshot must be present in the user prompt (grounding plumbing).
        seen["user"] = req.user  # type: ignore[attr-defined]
        return json.dumps(
            {
                "headline": "Recruiting velocity is the watch item.",
                "narrative": "Para one.\n\nPara two.\n\nPara three.",
                "keyMetrics": [{"label": "Open roles", "value": "12", "note": None}],
                "anomalies": [
                    {
                        "metric": "workforce.spanOfControl",
                        "detail": "A. Rivera has 11 direct reports (WIDE).",
                        "severity": "MEDIUM",
                    }
                ],
            }
        )

    monkeypatch.setattr("app.analytics.narrative.call_llm", _fake_call_llm)
    req = AnalyticsNarrativeRequest(orgId=_ORG, metrics=_metrics())
    resp = await generate_narrative(req, settings=_online_settings())

    assert "Staff SRE" in seen["user"]  # the snapshot reached the prompt
    assert resp.modelVersion == "claude-sonnet-4-6"
    assert "+offline_fallback" not in resp.modelVersion
    assert resp.headline.startswith("Recruiting velocity")
    assert resp.promptVersion == "module5.analytics_narrative@1.0.0"


@pytest.mark.asyncio
async def test_ask_llm_path_parses_chart(monkeypatch: pytest.MonkeyPatch) -> None:
    """With a key set, the ask surface parses the model's JSON incl. an optional chart."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        return json.dumps(
            {
                "answer": "Engineering has 142 employees.",
                "usedMetrics": ["workforce.byDepartment"],
                "chart": {
                    "type": "BAR",
                    "title": "Headcount by department",
                    "series": [{"label": "Engineering", "value": 142}],
                },
                "confidence": "high",
            }
        )

    monkeypatch.setattr("app.analytics.ask.call_llm", _fake_call_llm)
    req = AskDataRequest(orgId=_ORG, question="How many engineers?", metrics=_metrics())
    resp = await answer_data_question(req, settings=_online_settings())

    assert resp.modelVersion == "claude-sonnet-4-6"
    assert resp.chart is not None
    assert resp.chart.series[0].value == 142
    assert resp.confidence == "high"
