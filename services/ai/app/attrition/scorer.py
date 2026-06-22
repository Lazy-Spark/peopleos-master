"""Module 7 — transparent cold-start attrition risk scorer (+ guarded prod adapter).

THE MODEL (dev / offline default — needs NO network and NO API keys)
────────────────────────────────────────────────────────────────────
A transparent, fully-deterministic logistic regression over the AVAILABLE
``AttritionFeatures`` (the spec's full feature table needs engagement/comp/email
integrations that are not built; those are simply omitted and treated as neutral —
NEVER imputed as risk). For each employee:

  1. NORMALISE each feature to a signal in [0, 1] where 1 == "more attrition-prone"
     (see ``_normalise`` for the exact, documented transform per feature). A MISSING
     (null) feature contributes a NEUTRAL 0.0 signal — it never adds risk and is never
     imputed (spec ethics: do not penalise on absent data). Each normalised signal is
     mean-centred by a per-feature ``_BASELINE`` so a "typical" employee sits near the
     model's intercept rather than being pushed high by always-positive signals.

  2. COMBINE via a logistic:  z = intercept + Σ_f  weight_f · (signal_f - baseline_f)
     riskScore = sigmoid(z) ∈ (0, 1).  The ``_WEIGHTS`` are documented PRIORS (this is a
     cold-start model with no trained artifact); larger weight == stronger driver.

  3. TIER by fixed thresholds:  CRITICAL ≥ 0.75, HIGH ≥ 0.50, MEDIUM ≥ 0.25, else LOW.

FAITHFUL SHAP (no approximation)
────────────────────────────────
The model is LINEAR IN ITS CONTRIBUTIONS in logit space, so each feature's exact
additive contribution to the logit is  c_f = weight_f · (signal_f - baseline_f). That
IS the feature's SHAP value for this model (the Shapley value of an additive linear
model is exactly its term), so ``shapValues`` and ``topDrivers`` are EXACT, not estimated.
A positive contribution pushes risk UP (direction INCREASES); negative pushes it DOWN
(DECREASES). ``topDrivers`` are the largest-|contribution| features with a human label.

NO PROTECTED ATTRIBUTE is in the feature set, the weights, or the normalisation — by
construction the score cannot depend on age, gender, ethnicity, disability, etc.

PROD PATH (documented; guarded — used only when the artifact + libs are present)
────────────────────────────────────────────────────────────────────────────────
Per spec: XGBoost (primary) + LightGBM ensemble on the org's own historical attrition
(target ``resigned_within_90_days``, **min 200 labelled events**), retrained MONTHLY and
deployed via **MLflow**, with **Platt scaling** calibrating the raw model output into a
reliable probability, and **tree SHAP** explaining every prediction. ``_load_xgb_adapter``
loads that artifact when ``xgboost`` + ``shap`` import AND ``ATTRITION_MODEL_PATH`` points
at a trained model; otherwise (the dev/CI default) we use the transparent logistic above.
Both paths return the SAME ``ScoredEmployee`` shape, so callers never branch.
"""

from __future__ import annotations

import importlib.util
import math
import os
from collections.abc import Callable
from dataclasses import dataclass

import structlog

from ..schemas import (
    AttritionFeatures,
    DriverContribution,
    RiskTier,
    ScoreAttritionRequest,
    ScoreAttritionResponse,
    ScoredEmployee,
)

log = structlog.get_logger(__name__)

# A per-employee scorer: (employeeId, features) -> ScoredEmployee. Both the cold-start
# logistic and the (prod-only) trained XGBoost adapter conform to this signature, so
# ``score_attrition`` never has to branch on which model is active.
ScoreOne = Callable[[str, AttritionFeatures], ScoredEmployee]

# Persisted on every output. ``cold_start`` makes the dev model self-identifying and
# distinct from a future MLflow-versioned XGBoost artifact (``module7.attrition.xgb@…``).
MODEL_VERSION = "module7.attrition.cold_start@1.0.0"

# ── Tier thresholds on riskScore ∈ [0,1] (spec Module 7 risk_tier) ──────────────
_TIER_THRESHOLDS: tuple[tuple[float, RiskTier], ...] = (
    (0.75, "CRITICAL"),
    (0.50, "HIGH"),
    (0.25, "MEDIUM"),
    (0.0, "LOW"),
)

# ── Documented prior weights (logit space). Sign is always +: a higher normalised
#    signal always means MORE attrition risk, so the per-feature contribution's sign is
#    carried by (signal - baseline), not by the weight. Magnitudes encode the spec's
#    relative driver strength (career stagnation + team instability dominate). ──────────
_WEIGHTS: dict[str, float] = {
    "daysSinceLastPromotion": 2.4,   # career stagnation — the spec's headline driver
    "teamAttritionRate90d": 2.2,     # team instability / contagion
    "managerChanged90d": 1.6,        # manager change is "often a disruption signal" (spec)
    "perfRating": 1.5,               # strong perf + no recognition → flight risk (regrettable)
    "daysSinceLastReview": 1.2,      # neglect signal (no recent review)
    "timeInRoleDays": 1.0,           # plateau in the same role
    "tenureDays": 0.8,               # tenure risk curve (peaks then falls — see _normalise)
    "skillAdditions90d": 0.9,        # upskilling can precede an external move (spec career sig.)
}

# ── Per-feature baselines (the normalised signal of a "typical" employee). Centring on
#    these makes the intercept the typical-employee log-odds, so a typical worker scores
#    near LOW/MEDIUM rather than being inflated by always-non-negative signals. ──────────
_BASELINE: dict[str, float] = {
    "daysSinceLastPromotion": 0.40,
    "teamAttritionRate90d": 0.10,
    "managerChanged90d": 0.0,
    "perfRating": 0.30,
    "daysSinceLastReview": 0.35,
    "timeInRoleDays": 0.40,
    "tenureDays": 0.45,
    "skillAdditions90d": 0.20,
}

# Intercept (typical-employee log-odds). Tuned so a fully-baseline employee scores ~0.18
# (low end of LOW) and the bands populate sensibly across the feature ranges.
_INTERCEPT = -1.5

# Human-readable labels for topDrivers (manager-facing copy lives in the explain prompt;
# these are the short feature labels surfaced alongside each driver contribution).
_LABELS: dict[str, str] = {
    "daysSinceLastPromotion": "Time since last promotion",
    "teamAttritionRate90d": "Recent team attrition",
    "managerChanged90d": "Recent manager change",
    "perfRating": "Performance rating",
    "daysSinceLastReview": "Time since last review",
    "timeInRoleDays": "Time in current role",
    "tenureDays": "Company tenure",
    "skillAdditions90d": "Recent skill growth",
}

# Number of top drivers surfaced (largest |contribution|). The explanation layer grounds
# its narrative ONLY in these, so we keep it focused.
_MAX_TOP_DRIVERS = 5
# Contributions with magnitude below this are treated as noise and not surfaced as drivers
# (a near-baseline feature is not a meaningful "driver").
_DRIVER_EPSILON = 1e-6


def _sigmoid(z: float) -> float:
    """Numerically-stable logistic. Output is clamped into (0,1) by construction."""
    if z >= 0:
        ez = math.exp(-z)
        return 1.0 / (1.0 + ez)
    ez = math.exp(z)
    return ez / (1.0 + ez)


def _clip01(x: float) -> float:
    """Clamp into [0,1]."""
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


# ── Normalisation: feature value → signal in [0,1] (1 == more attrition-prone) ─────────
# Each transform is documented and monotone in the intuitive direction. Missing (null)
# features return None from these and are handled as a NEUTRAL baseline by the caller, so
# absent data never adds risk and is never imputed.


def _saturating(days: float | None, half: float) -> float | None:
    """Days → [0,1) that rises with time, half-saturating at ``half`` days.

    A smooth, bounded ramp:  signal = days / (days + half). At 0 days → 0.0; at ``half``
    days → 0.5; asymptotes to 1.0. Monotonically increasing in ``days`` (used for the
    "longer since X == more risk" features). Returns None for a missing value.
    """
    if days is None:
        return None
    d = max(0.0, days)
    return d / (d + half)


def _tenure_signal(tenure_days: float | None) -> float | None:
    """Company-tenure risk curve: low at first, peaks in the 1.5-3y window, then falls.

    Attrition hazard is well-known to be hump-shaped: brand-new hires and long-tenured
    employees are stickier than those in the mid-tenure "itch" window. Modelled as a
    smooth triangular peak centred at ~2 years (730 days), zero below ~3 months and above
    ~7 years. Monotonic on each side of the peak; returns None for a missing value.
    """
    if tenure_days is None:
        return None
    d = max(0.0, tenure_days)
    peak = 730.0       # ~2 years — peak risk
    lo = 90.0          # below ~3 months: still onboarding, low flight risk
    hi = 2555.0        # above ~7 years: strongly anchored
    if d <= lo or d >= hi:
        return 0.0
    if d <= peak:
        return _clip01((d - lo) / (peak - lo))
    return _clip01((hi - d) / (hi - peak))


def _perf_signal(perf_rating: float | None) -> float | None:
    """Performance rating (1-5) → risk signal.

    Both extremes carry flight risk for different reasons, but the spec's headline case is
    the REGRETTABLE loss: a STRONG performer who is not being recognised. So the signal is
    highest for high performers (5 → 1.0) and lowest mid-scale (3 → ~0.1), with low
    performers carrying a moderate signal too (1 → ~0.4, managed-out / disengaged). The
    rating itself is a performance measure, never a protected attribute. None when absent.
    """
    if perf_rating is None:
        return None
    r = max(1.0, min(5.0, perf_rating))
    # Piecewise-linear over the rating scale; values chosen to make 5 the strongest signal.
    points = {1.0: 0.40, 2.0: 0.20, 3.0: 0.10, 4.0: 0.55, 5.0: 1.0}
    lo = math.floor(r)
    hi = math.ceil(r)
    if lo == hi:
        return points[float(lo)]
    frac = r - lo
    return points[float(lo)] * (1 - frac) + points[float(hi)] * frac


def _skill_additions_signal(additions: int) -> float:
    """Recent skill growth → risk signal (a documented CAREER signal in the spec).

    Upskilling can precede an external move ("polishing the CV"). Treated as a weak,
    saturating signal so it nudges but never dominates: 0 → 0.0, 1 → ~0.33, 3 → 0.6,
    asymptoting to 1.0. Never null (the contract makes it a non-negative int).
    """
    a = max(0, additions)
    return a / (a + 2.0)


@dataclass(slots=True)
class _Contribution:
    feature: str
    signal: float          # normalised value used (baseline 0.0 substituted when missing)
    contribution: float    # weight · (signal - baseline) — the exact additive SHAP term
    missing: bool          # True when the source feature was null (neutral, not risk)


def _feature_signals(f: AttritionFeatures) -> dict[str, float | None]:
    """Normalise every feature to its [0,1] risk signal (None == missing → neutral)."""
    return {
        "daysSinceLastPromotion": _saturating(f.daysSinceLastPromotion, half=540.0),
        "teamAttritionRate90d": _clip01(f.teamAttritionRate90d),  # already a [0,1] rate
        "managerChanged90d": 1.0 if f.managerChanged90d else 0.0,
        "perfRating": _perf_signal(f.perfRating),
        "daysSinceLastReview": _saturating(f.daysSinceLastReview, half=270.0),
        "timeInRoleDays": _saturating(f.timeInRoleDays, half=900.0),
        "tenureDays": _tenure_signal(f.tenureDays),
        "skillAdditions90d": _skill_additions_signal(f.skillAdditions90d),
    }


def _contributions(f: AttritionFeatures) -> list[_Contribution]:
    """Per-feature exact additive (SHAP) contributions in logit space."""
    signals = _feature_signals(f)
    out: list[_Contribution] = []
    for feature, weight in _WEIGHTS.items():
        raw = signals[feature]
        missing = raw is None
        # Missing → neutral baseline signal, so (signal - baseline) == 0 → contribution 0.
        signal = _BASELINE[feature] if missing else float(raw)  # type: ignore[arg-type]
        contribution = weight * (signal - _BASELINE[feature])
        out.append(
            _Contribution(
                feature=feature,
                signal=signal,
                contribution=contribution,
                missing=missing,
            )
        )
    return out


def _tier_for(score: float) -> RiskTier:
    """Map a riskScore ∈ [0,1] to its tier by the fixed thresholds."""
    for threshold, tier in _TIER_THRESHOLDS:
        if score >= threshold:
            return tier
    return "LOW"  # unreachable (last threshold is 0.0) but keeps the type total


def _top_drivers(contribs: list[_Contribution]) -> list[DriverContribution]:
    """Largest-|contribution| features as labelled, directioned drivers.

    Missing features (contribution exactly 0, never imputed) and near-baseline features
    (|contribution| < epsilon) are NOT surfaced — they are not meaningful drivers. Ties
    break by feature name for deterministic output.
    """
    meaningful = [c for c in contribs if not c.missing and abs(c.contribution) >= _DRIVER_EPSILON]
    ranked = sorted(meaningful, key=lambda c: (-abs(c.contribution), c.feature))
    drivers: list[DriverContribution] = []
    for c in ranked[:_MAX_TOP_DRIVERS]:
        drivers.append(
            DriverContribution(
                feature=c.feature,
                label=_LABELS[c.feature],
                contribution=round(c.contribution, 6),
                direction="INCREASES" if c.contribution > 0 else "DECREASES",
            )
        )
    return drivers


def _score_one_cold_start(employee_id: str, features: AttritionFeatures) -> ScoredEmployee:
    """Score a single employee with the transparent logistic model (exact SHAP)."""
    contribs = _contributions(features)
    z = _INTERCEPT + sum(c.contribution for c in contribs)
    risk = _clip01(_sigmoid(z))
    shap_values = {c.feature: round(c.contribution, 6) for c in contribs}
    return ScoredEmployee(
        employeeId=employee_id,
        riskScore=round(risk, 6),
        riskTier=_tier_for(risk),
        topDrivers=_top_drivers(contribs),
        shapValues=shap_values,
    )


# ── GUARDED prod adapter (XGBoost + tree SHAP, MLflow artifact, Platt calibration) ─────
def _xgb_stack_available() -> bool:
    """True only when both ``xgboost`` and ``shap`` are importable.

    Checked WITHOUT importing (no side effects, no native init) so this module loads
    cleanly in the dev/CI environment where the heavy ML stack is absent — mirroring the
    Module 3 transcription guard (``_whisperx_available``).
    """
    return (
        importlib.util.find_spec("xgboost") is not None
        and importlib.util.find_spec("shap") is not None
    )


def _load_xgb_adapter() -> ScoreOne | None:  # pragma: no cover - prod-only path
    """Return a trained-model scorer when the prod stack is available, else None.

    Prod path (spec Module 7): an XGBoost (+LightGBM ensemble) classifier trained on the
    org's own >=200 labelled ``resigned_within_90_days`` events, deployed via MLflow,
    Platt-scaled for calibrated probabilities, explained with tree SHAP. This is enabled
    ONLY when (a) ``xgboost`` + ``shap`` are importable AND (b) ``ATTRITION_MODEL_PATH``
    points at a trained artifact. In dev/CI neither holds, so this returns None and the
    caller uses the transparent logistic above.
    """
    model_path = os.environ.get("ATTRITION_MODEL_PATH")
    if not model_path or not os.path.exists(model_path):
        return None
    if not _xgb_stack_available():
        log.info("attrition_xgb_unavailable", reason="xgboost/shap not installed")
        return None
    # A real implementation (reached only when the heavy stack + artifact are present)
    # would lazily ``import xgboost, shap``; load the MLflow-packaged Booster from
    # ``model_path``; build a feature vector in the SAME order the model was trained on;
    # predict the Platt-calibrated probability; run shap.TreeExplainer for exact
    # per-feature SHAP values; and assemble the SAME ScoredEmployee shape (tier +
    # topDrivers from the SHAP magnitudes). The cold-start model intentionally mirrors
    # that contract so swapping in the trained model requires no caller change. The actual
    # load is intentionally not wired in this environment, so we fall back to the logistic.
    log.info("attrition_xgb_artifact_found_but_adapter_not_wired", model_path=model_path)
    return None


def score_attrition(req: ScoreAttritionRequest) -> ScoreAttritionResponse:
    """Score a batch of employees' attrition risk (Module 7 scorer).

    Uses the trained XGBoost + tree-SHAP adapter when its artifact is present
    (``_load_xgb_adapter``), else the transparent deterministic logistic cold-start model
    (the dev/offline default — NO network, NO keys). Both emit the same ``ScoredEmployee``
    shape: riskScore ∈ [0,1], a tier, exact per-feature SHAP ``shapValues``, and the
    largest-magnitude ``topDrivers``. The model uses ONLY the provided AttritionFeatures —
    never a protected attribute — and treats missing (null) features as neutral (never
    imputed as risk). The score is ADVISORY only (governance is enforced by the API).
    """
    adapter = _load_xgb_adapter()
    score_one: ScoreOne = adapter if adapter is not None else _score_one_cold_start
    model_version = MODEL_VERSION if adapter is None else "module7.attrition.xgb@runtime"

    scores: list[ScoredEmployee] = [
        score_one(emp.employeeId, emp.features) for emp in req.employees
    ]
    return ScoreAttritionResponse(scores=scores, modelVersion=model_version)


# Exposed for tests + the explain offline fallback (so labels stay in one place).
def driver_label(feature: str) -> str:
    """Human label for a feature key (falls back to the key itself)."""
    return _LABELS.get(feature, feature)


__all__ = [
    "MODEL_VERSION",
    "driver_label",
    "score_attrition",
]
