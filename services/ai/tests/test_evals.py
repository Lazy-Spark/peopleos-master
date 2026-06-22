"""Unit tests for the Module 1 eval metrics (spec Layer 6) on tiny KNOWN inputs.

These exercise the pure metric functions (precision_at_k, dcg/ndcg_at_k, selection
rate + parity, tier_relevance) with exact expected values, plus a smoke test that the
full offline eval harness runs and reports the job-level metrics without network.
"""

from __future__ import annotations

import math

import pytest
from app.evals.metrics import (
    DEFAULT_GOOD_TIERS,
    dcg_at_k,
    ndcg_at_k,
    precision_at_k,
    selection_rate,
    selection_rate_parity,
    tier_relevance,
)
from app.evals.run_evals import run_evals


# ── tier_relevance ──────────────────────────────────────────────────────────
def test_tier_relevance_grading() -> None:
    assert tier_relevance("A") == 3
    assert tier_relevance("B") == 2
    assert tier_relevance("C") == 1
    assert tier_relevance("D") == 0
    # Unknown tier maps to 0 (irrelevant) rather than raising.
    assert tier_relevance("Z") == 0


# ── precision_at_k ────────────────────────────────────────────────────────────
def test_precision_at_3_two_of_three_good() -> None:
    # top-3 = [A, B, C]; good = {A, B} => 2/3.
    assert precision_at_k(["A", "B", "C"], 3) == pytest.approx(2.0 / 3.0)


def test_precision_at_k_truncates_to_k() -> None:
    # Only the first 2 are considered; both good => 1.0.
    assert precision_at_k(["A", "B", "C", "D"], 2) == pytest.approx(1.0)


def test_precision_at_k_divides_by_available_when_fewer_than_k() -> None:
    # Only 2 items but k=3 => divide by 2; one good => 0.5.
    assert precision_at_k(["A", "D"], 3) == pytest.approx(0.5)


def test_precision_at_k_custom_good_tiers() -> None:
    # good = {A} only => of [A, B, C] just 1/3.
    assert precision_at_k(["A", "B", "C"], 3, frozenset({"A"})) == pytest.approx(1.0 / 3.0)


def test_precision_at_k_edge_cases() -> None:
    assert precision_at_k([], 3) == 0.0
    assert precision_at_k(["A"], 0) == 0.0
    assert precision_at_k(["A"], -1) == 0.0


# ── dcg / ndcg_at_k ───────────────────────────────────────────────────────────
def test_dcg_at_k_known_value() -> None:
    # 3/log2(2) + 2/log2(3) + 1/log2(4) = 3 + 2/1.58496 + 0.5 = 4.76185950714...
    assert dcg_at_k([3, 2, 1], 3) == pytest.approx(4.7618595071429155)


def test_ndcg_perfect_order_is_one() -> None:
    assert ndcg_at_k([3, 2, 1], 3) == pytest.approx(1.0)


def test_ndcg_imperfect_order_known_value() -> None:
    # model order [3,1,2] vs ideal [3,2,1]:
    #   DCG  = 3/1 + 1/log2(3) + 2/log2(4) = 3 + 0.63093 + 1 = 4.63093
    #   IDCG = 4.76185950714...
    #   NDCG = 4.63093.../4.76186... = 0.9725044904464192
    assert ndcg_at_k([3, 1, 2], 3) == pytest.approx(0.9725044904464192)


def test_ndcg_all_irrelevant_is_zero() -> None:
    # IDCG == 0 => well-defined 0.0 (no division by zero).
    assert ndcg_at_k([0, 0, 0], 3) == 0.0


def test_ndcg_edge_cases() -> None:
    assert ndcg_at_k([], 5) == 0.0
    assert ndcg_at_k([3, 2], 0) == 0.0


def test_ndcg_from_tier_relevances_roundtrip() -> None:
    # A ranker that puts [A, C, B] should score below 1 but above the worst case.
    rels = [float(tier_relevance(t)) for t in ["A", "C", "B"]]  # [3, 1, 2]
    assert ndcg_at_k(rels, 3) == pytest.approx(0.9725044904464192)


# ── selection_rate + parity ────────────────────────────────────────────────────
def test_selection_rate_half() -> None:
    assert selection_rate(["A", "B", "C", "D"]) == pytest.approx(0.5)
    assert selection_rate([]) == 0.0


def test_selection_rate_parity_known_ratio() -> None:
    # x selects 1/2 = 0.5, y selects 2/2 = 1.0 => min/max = 0.5.
    groups = {"x": ["A", "C"], "y": ["A", "B"]}
    assert selection_rate_parity(groups) == pytest.approx(0.5)


def test_selection_rate_parity_equal_groups_is_one() -> None:
    groups = {"x": ["A", "A"], "y": ["A", "B"]}
    assert selection_rate_parity(groups) == pytest.approx(1.0)


def test_selection_rate_parity_undefined_cases() -> None:
    # Fewer than 2 groups -> None.
    assert selection_rate_parity({"x": ["A", "B"]}) is None
    # Every group selects nobody (max rate 0) -> None.
    assert selection_rate_parity({"x": ["C", "D"], "y": ["D", "D"]}) is None


def test_default_good_tiers_is_a_and_b() -> None:
    assert frozenset({"A", "B"}) == DEFAULT_GOOD_TIERS


# ── full offline eval harness ───────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_eval_harness_runs_offline_with_job_level_metrics() -> None:
    """The eval suite runs end-to-end offline and computes job-level P@3/NDCG/parity."""
    summary = await run_evals()

    # Spec: >= 12 golden cases, plus at least one job-level ranking case.
    assert summary.n >= 12
    assert len(summary.ranking_cases) >= 1

    # Deterministic offline path should rank sensibly.
    assert summary.within_one_accuracy >= 0.8
    assert summary.precision_at_3 >= 0.66

    # Job-level metrics are well-defined and strong on the (separable) golden shortlist.
    assert summary.ranking_precision_at_3 >= 0.66
    assert 0.0 <= summary.ndcg_at_5 <= 1.0 + 1e-9
    assert summary.ndcg_at_5 >= 0.8
    # Parity is computed from the model's ACTUAL tiers and is gated ONLY when a real LLM
    # produced them — the offline deterministic heuristic systematically under-scores and
    # is not a fairness oracle, so offline parity is reported as n/a (None) by design.
    assert summary.selection_rate_parity is None

    # Every case produced a valid tier.
    assert all(c.actual_tier in {"A", "B", "C", "D"} for c in summary.cases)


@pytest.mark.asyncio
async def test_eval_gate_passes_offline() -> None:
    """The documented CI gate must pass on the offline deterministic path."""
    summary = await run_evals()
    failures = summary.gate_failures()
    assert failures == [], f"unexpected gate failures: {failures}"


def test_ndcg_matches_manual_log2_formula() -> None:
    """Guard the discount math against accidental base/offset changes."""
    rels = [2.0, 0.0, 3.0]
    expected = 2.0 / math.log2(2) + 0.0 / math.log2(3) + 3.0 / math.log2(4)
    assert dcg_at_k(rels, 3) == pytest.approx(expected)
