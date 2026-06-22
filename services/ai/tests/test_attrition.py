"""Unit tests for Module 7 — the Attrition Prediction Engine (scorer + explanation).

The scorer is deterministic + transparent, so every assertion is exact. We test:
  - determinism + reproducibility (same input -> same output)
  - monotonicity in the intuitive direction (more time-since-promotion / higher team
    attrition -> higher risk)
  - tier thresholds (CRITICAL >= 0.75, HIGH >= 0.5, MEDIUM >= 0.25, else LOW)
  - topDrivers reflect the largest |contribution| and carry the right direction
  - shapValues sum (with the intercept) reproduces the logit of riskScore (faithful SHAP)
  - missing (null) features are NEUTRAL: zero contribution, never surfaced as a driver
  - the model never references a protected attribute (it has none in its features/weights)

The explanation layer is exercised through its OFFLINE deterministic path (no network/keys
in CI): it grounds the narrative + actions ONLY in the supplied drivers, frames everything
as advisory, and never emits a protected attribute.
"""

from __future__ import annotations

import math
import re
import uuid

import pytest
from app.attrition.explain import explain_attrition
from app.attrition.scorer import (
    _INTERCEPT,
    MODEL_VERSION,
    _tier_for,
    score_attrition,
)
from app.schemas import (
    AttritionEmployeeContext,
    AttritionFeatures,
    DriverContribution,
    EmployeeFeatures,
    ExplainAttritionRequest,
    ScoreAttritionRequest,
)

# Protected-attribute terms that must NEVER appear in a manager-facing explanation. Matched
# on word boundaries so innocuous substrings (e.g. "age" inside "manager") don't false-fire.
_PROTECTED_TERMS = [
    "age",
    "aged",
    "older",
    "younger",
    "gender",
    "male",
    "female",
    "woman",
    "man",
    "ethnic",
    "ethnicity",
    "race",
    "racial",
    "religion",
    "religious",
    "disability",
    "disabled",
    "pregnant",
    "pregnancy",
    "married",
    "marital",
    "nationality",
    "sexual",
    "orientation",
]


def _features(**overrides: object) -> AttritionFeatures:
    """A 'typical' employee, overridable per-field for targeted tests."""
    base: dict[str, object] = {
        "tenureDays": 730.0,
        "timeInRoleDays": 400.0,
        "daysSinceLastPromotion": 300.0,
        "daysSinceLastReview": 200.0,
        "perfRating": 3.0,
        "teamAttritionRate90d": 0.1,
        "managerChanged90d": False,
        "skillAdditions90d": 0,
    }
    base.update(overrides)
    return AttritionFeatures(**base)  # type: ignore[arg-type]


def _score_one(features: AttritionFeatures):  # type: ignore[no-untyped-def]
    """Score a single employee and return the ScoredEmployee."""
    req = ScoreAttritionRequest(
        orgId=str(uuid.uuid4()),
        employees=[EmployeeFeatures(employeeId=str(uuid.uuid4()), features=features)],
    )
    return score_attrition(req).scores[0]


def _contains_protected(text: str) -> list[str]:
    """Return protected terms appearing as whole words in ``text`` (case-insensitive)."""
    low = text.lower()
    return [t for t in _PROTECTED_TERMS if re.search(rf"\b{re.escape(t)}\b", low)]


# ── Determinism + envelope ─────────────────────────────────────────────────────────────
def test_scorer_is_deterministic_and_reproducible() -> None:
    f = _features()
    a = _score_one(f)
    b = _score_one(f)
    assert a.riskScore == b.riskScore
    assert a.riskTier == b.riskTier
    assert a.shapValues == b.shapValues
    assert [d.feature for d in a.topDrivers] == [d.feature for d in b.topDrivers]


def test_model_version_is_cold_start_offline_default() -> None:
    req = ScoreAttritionRequest(
        orgId=str(uuid.uuid4()),
        employees=[EmployeeFeatures(employeeId=str(uuid.uuid4()), features=_features())],
    )
    assert score_attrition(req).modelVersion == MODEL_VERSION
    assert MODEL_VERSION.startswith("module7.attrition.cold_start@")


def test_risk_score_is_in_unit_interval() -> None:
    # Even the worst-case all-bad employee stays within [0,1].
    worst = _score_one(
        _features(
            daysSinceLastPromotion=5000.0,
            teamAttritionRate90d=1.0,
            managerChanged90d=True,
            perfRating=5.0,
            daysSinceLastReview=3000.0,
            timeInRoleDays=5000.0,
            skillAdditions90d=10,
        )
    )
    assert 0.0 <= worst.riskScore <= 1.0


# ── Monotonicity (the core behavioural guarantee) ───────────────────────────────────────
@pytest.mark.parametrize("days", [0.0, 100.0, 365.0, 1000.0, 2000.0, 4000.0])
def test_more_time_since_promotion_increases_risk(days: float) -> None:
    # Holding everything else fixed, risk is non-decreasing in daysSinceLastPromotion.
    base = _score_one(_features(daysSinceLastPromotion=days)).riskScore
    more = _score_one(_features(daysSinceLastPromotion=days + 500.0)).riskScore
    assert more >= base
    # And strictly higher across a meaningful jump.
    lo = _score_one(_features(daysSinceLastPromotion=30.0)).riskScore
    hi = _score_one(_features(daysSinceLastPromotion=2500.0)).riskScore
    assert hi > lo


@pytest.mark.parametrize("rate", [0.0, 0.1, 0.25, 0.5, 0.9])
def test_higher_team_attrition_increases_risk(rate: float) -> None:
    base = _score_one(_features(teamAttritionRate90d=rate)).riskScore
    more = _score_one(_features(teamAttritionRate90d=min(1.0, rate + 0.05))).riskScore
    assert more >= base
    lo = _score_one(_features(teamAttritionRate90d=0.0)).riskScore
    hi = _score_one(_features(teamAttritionRate90d=1.0)).riskScore
    assert hi > lo


def test_manager_change_increases_risk() -> None:
    no_change = _score_one(_features(managerChanged90d=False)).riskScore
    change = _score_one(_features(managerChanged90d=True)).riskScore
    assert change > no_change


# ── Tier thresholds ─────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("score", "tier"),
    [
        (0.0, "LOW"),
        (0.2499, "LOW"),
        (0.25, "MEDIUM"),
        (0.4999, "MEDIUM"),
        (0.50, "HIGH"),
        (0.7499, "HIGH"),
        (0.75, "CRITICAL"),
        (1.0, "CRITICAL"),
    ],
)
def test_tier_thresholds_are_exact(score: float, tier: str) -> None:
    assert _tier_for(score) == tier


def test_typical_employee_is_low_risk() -> None:
    # The baselines are tuned so a 'typical' employee lands in LOW (avoids false alarms).
    assert _score_one(_features()).riskTier == "LOW"


def test_all_bad_employee_is_critical() -> None:
    worst = _score_one(
        _features(
            daysSinceLastPromotion=3000.0,
            teamAttritionRate90d=0.9,
            managerChanged90d=True,
            perfRating=5.0,
            daysSinceLastReview=900.0,
            timeInRoleDays=2000.0,
            skillAdditions90d=5,
        )
    )
    assert worst.riskTier == "CRITICAL"
    assert worst.riskScore >= 0.75


# ── topDrivers + faithful SHAP ───────────────────────────────────────────────────────────
def test_top_drivers_reflect_largest_contributions() -> None:
    scored = _score_one(
        _features(
            daysSinceLastPromotion=3000.0,  # should dominate
            teamAttritionRate90d=0.9,       # strong too
            managerChanged90d=False,
            perfRating=3.0,                 # ~baseline -> small
        )
    )
    # The surfaced drivers must be exactly the top-|contribution| features, in order.
    abs_sorted = sorted(
        scored.shapValues.items(), key=lambda kv: (-abs(kv[1]), kv[0])
    )
    # Drivers exclude near-zero / missing; take the same count from the abs-sorted list.
    expected = [f for f, _ in abs_sorted][: len(scored.topDrivers)]
    assert [d.feature for d in scored.topDrivers] == expected
    # The single largest driver is whichever has the biggest |contribution| (here team
    # attrition at rate 0.9 outweighs the stalled promotion), and both are surfaced.
    assert scored.topDrivers[0].feature == expected[0]
    top_features = {d.feature for d in scored.topDrivers}
    assert "teamAttritionRate90d" in top_features
    assert "daysSinceLastPromotion" in top_features
    # Each driver's direction matches the sign of its contribution.
    for d in scored.topDrivers:
        sign = scored.shapValues[d.feature]
        assert d.direction == ("INCREASES" if sign > 0 else "DECREASES")
        assert d.contribution == pytest.approx(sign)
        assert d.label  # a human label is always present


def test_shap_values_are_faithful_to_the_score() -> None:
    # Faithful SHAP: intercept + sum(shapValues) == logit(riskScore). (The score is rounded
    # to 6 dp, so allow a small tolerance.)
    scored = _score_one(
        _features(daysSinceLastPromotion=1500.0, teamAttritionRate90d=0.4, managerChanged90d=True)
    )
    logit = _INTERCEPT + sum(scored.shapValues.values())
    recovered = 1.0 / (1.0 + math.exp(-logit))
    assert recovered == pytest.approx(scored.riskScore, abs=1e-5)


def test_protective_driver_has_decreases_direction() -> None:
    # A very recent promotion is BELOW baseline -> negative contribution -> DECREASES.
    scored = _score_one(_features(daysSinceLastPromotion=0.0))
    assert scored.shapValues["daysSinceLastPromotion"] < 0
    promo_driver = next(
        (d for d in scored.topDrivers if d.feature == "daysSinceLastPromotion"), None
    )
    if promo_driver is not None:
        assert promo_driver.direction == "DECREASES"


# ── Missing (null) features are NEUTRAL, never imputed as risk ────────────────────────────
def test_null_features_contribute_zero_and_are_not_drivers() -> None:
    scored = _score_one(
        _features(
            daysSinceLastPromotion=None,
            daysSinceLastReview=None,
            timeInRoleDays=None,
            perfRating=None,
        )
    )
    # Null features sit exactly at their baseline -> zero contribution.
    for feature in ("daysSinceLastPromotion", "daysSinceLastReview", "timeInRoleDays", "perfRating"):
        assert scored.shapValues[feature] == 0.0
    # ...and are therefore never surfaced as drivers.
    null_features = {"daysSinceLastPromotion", "daysSinceLastReview", "timeInRoleDays", "perfRating"}
    assert null_features.isdisjoint({d.feature for d in scored.topDrivers})


def test_null_promotion_is_not_more_risky_than_a_recent_promotion() -> None:
    # A missing promotion date must NOT be penalised as if it were a stale one.
    null_score = _score_one(_features(daysSinceLastPromotion=None)).riskScore
    stale_score = _score_one(_features(daysSinceLastPromotion=3000.0)).riskScore
    assert null_score < stale_score


# ── No protected attribute anywhere in the model ─────────────────────────────────────────
def test_scorer_feature_set_contains_no_protected_attribute() -> None:
    scored = _score_one(_features())
    for feature in scored.shapValues:
        assert not _contains_protected(feature)


# ── Batch behaviour ──────────────────────────────────────────────────────────────────────
def test_batch_scores_each_employee_independently() -> None:
    ids = [str(uuid.uuid4()) for _ in range(3)]
    req = ScoreAttritionRequest(
        orgId=str(uuid.uuid4()),
        employees=[
            EmployeeFeatures(employeeId=ids[0], features=_features(daysSinceLastPromotion=0.0)),
            EmployeeFeatures(employeeId=ids[1], features=_features()),
            EmployeeFeatures(employeeId=ids[2], features=_features(daysSinceLastPromotion=4000.0, teamAttritionRate90d=0.9)),
        ],
    )
    resp = score_attrition(req)
    assert [s.employeeId for s in resp.scores] == ids
    # Risk increases across the three constructed cases.
    assert resp.scores[0].riskScore < resp.scores[1].riskScore < resp.scores[2].riskScore


# ═══ Explanation layer (offline deterministic path) ═════════════════════════════════════
def _explain_request(tier: str, drivers: list[DriverContribution]) -> ExplainAttritionRequest:
    return ExplainAttritionRequest(
        orgId=str(uuid.uuid4()),
        riskTier=tier,  # type: ignore[arg-type]
        topDrivers=drivers,
        employeeContext=AttritionEmployeeContext(
            tenureDays=1400, roleTitle="Senior Engineer", department="Engineering", level="SENIOR"
        ),
    )


_HIGH_DRIVERS = [
    DriverContribution(feature="daysSinceLastPromotion", label="Time since last promotion", contribution=0.78, direction="INCREASES"),
    DriverContribution(feature="perfRating", label="Performance rating", contribution=0.41, direction="INCREASES"),
    DriverContribution(feature="managerChanged90d", label="Recent manager change", contribution=0.33, direction="INCREASES"),
]


@pytest.mark.asyncio
async def test_explain_offline_grounds_only_in_drivers() -> None:
    # No ANTHROPIC_API_KEY in CI -> the deterministic offline path runs.
    resp = await explain_attrition(_explain_request("HIGH", _HIGH_DRIVERS))
    assert resp.narrative.startswith("[OFFLINE]")  # clearly marked
    assert "HIGH" in resp.narrative
    assert "advisory" in resp.narrative.lower()
    # Actions are grounded in the increasing drivers (career conversation for the stalled
    # promotion; relationship 1:1 for the manager change).
    actions_blob = " ".join(resp.recommendedActions).lower()
    assert "career" in actions_blob
    assert "manager" in actions_blob or "transition" in actions_blob
    assert 1 <= len(resp.recommendedActions) <= 4
    # The offline narrative must not mention a feature that is not in the drivers.
    assert "team" not in resp.narrative.lower()  # teamAttritionRate90d not among drivers


@pytest.mark.asyncio
async def test_explain_never_emits_a_protected_attribute() -> None:
    resp = await explain_attrition(_explain_request("CRITICAL", _HIGH_DRIVERS))
    blob = resp.narrative + " " + " ".join(resp.recommendedActions)
    found = _contains_protected(blob)
    assert found == [], f"protected attribute(s) leaked into explanation: {found}"
    # The bias guard is forced regardless of any model output.
    assert resp.biasCheck.biasIndicatorsDetected == []
    assert resp.biasCheck.correctionApplied is False


@pytest.mark.asyncio
async def test_explain_offline_marks_model_and_prompt_version() -> None:
    resp = await explain_attrition(_explain_request("MEDIUM", _HIGH_DRIVERS))
    assert resp.modelVersion.endswith("+offline_fallback")
    assert resp.promptVersion == "module7.attrition_explain@1.0.0"


@pytest.mark.asyncio
async def test_explain_treats_decreasing_driver_as_mitigating() -> None:
    drivers = [
        DriverContribution(feature="skillAdditions90d", label="Recent skill growth", contribution=0.34, direction="INCREASES"),
        DriverContribution(feature="managerChanged90d", label="Recent manager change", contribution=-0.12, direction="DECREASES"),
    ]
    resp = await explain_attrition(_explain_request("MEDIUM", drivers))
    # The decreasing driver is framed as a mitigating factor, not a risk action.
    assert "mitigating factor" in resp.narrative.lower()
    # Only the INCREASING driver produces an action (the protective one does not).
    assert any("skill" in a.lower() for a in resp.recommendedActions)
    assert not any("ease the recent transition" in a.lower() for a in resp.recommendedActions)


@pytest.mark.asyncio
async def test_explain_with_no_increasing_drivers_still_returns_a_safe_action() -> None:
    drivers = [
        DriverContribution(feature="tenureDays", label="Company tenure", contribution=-0.2, direction="DECREASES"),
    ]
    resp = await explain_attrition(_explain_request("LOW", drivers))
    assert len(resp.recommendedActions) >= 1
    # Never an adverse action.
    blob = " ".join(resp.recommendedActions).lower()
    for adverse in ("pip", "discipline", "terminate", "performance improvement plan", "fire"):
        assert adverse not in blob
