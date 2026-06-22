"""Module 7 — Attrition Prediction Engine (AI service surfaces).

Two surfaces, both governed by the spec's ethics rules (the score is ADVISORY ONLY):

  scorer  — a TRANSPARENT cold-start risk model (``score_attrition``). Each
            AttritionFeatures field is normalised to a [0,1]-ish signal, combined with
            documented prior WEIGHTS through a logistic (sigmoid) into a riskScore in
            [0,1], then tiered (CRITICAL/HIGH/MEDIUM/LOW). Because the model is
            linear-in-contributions, the per-feature contribution (weight x normalised
            value) IS a faithful SHAP value, so ``shapValues`` + ``topDrivers`` are exact
            (no approximation). Runs with NO network and NO keys — this is the dev/offline
            default. A GUARDED adapter swaps in XGBoost + tree SHAP when a trained model
            artifact is present (the documented prod path). The model uses ONLY the
            provided features — NEVER a protected attribute.

  explain — a manager-facing LLM narrative (``explain_attrition``) GROUNDED ONLY in the
            supplied topDrivers (never the raw score, never a protected attribute, never
            inferred personal circumstances). Offline: a deterministic templated narrative.

Governance note: this service computes scores + explanations from features the API
supplies; it never sees the raw score → manager mapping, the opt-out list, or any
protected attribute (those are enforced by the API + the contract's role-gated views).
"""

from __future__ import annotations

from .explain import explain_attrition
from .scorer import MODEL_VERSION, score_attrition

__all__ = ["MODEL_VERSION", "explain_attrition", "score_attrition"]
