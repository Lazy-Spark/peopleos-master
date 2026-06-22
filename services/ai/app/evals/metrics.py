"""Ranking eval metrics (spec Layer 6: "Resume ranking: Precision@3, NDCG, bias parity").

Pure, dependency-free functions used by ``run_evals`` and unit-tested directly in
``tests/test_evals.py``. None of these call the network or an LLM — they operate on
already-computed rankings and labels, so they form a deterministic CI gate.

Graded relevance convention
----------------------------
Expected candidate *tier* is mapped to a graded relevance score (higher = more
relevant), so NDCG can reward putting genuinely strong candidates near the top:

    A -> 3   B -> 2   C -> 1   D -> 0

For binary metrics (Precision@k, selection-rate parity) the caller supplies which
tiers count as a positive ("good"/"selected") outcome — by default A and B, matching
the disparity audit's default ``selectionTiers``.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

# Graded relevance from expected tier (spec: "graded relevance from expected tier").
TIER_RELEVANCE: dict[str, int] = {"A": 3, "B": 2, "C": 1, "D": 0}

# Tiers that count as a positive selection outcome by default (mirrors audit default).
DEFAULT_GOOD_TIERS: frozenset[str] = frozenset({"A", "B"})


def tier_relevance(tier: str) -> int:
    """Map an expected tier (A/B/C/D) to a graded relevance score (3/2/1/0).

    Unknown tiers map to 0 (treated as irrelevant) rather than raising, so a partial
    label set never crashes the eval run.
    """
    return TIER_RELEVANCE.get(tier, 0)


def precision_at_k(
    ranked_tiers: Sequence[str],
    k: int,
    good_tiers: frozenset[str] = DEFAULT_GOOD_TIERS,
) -> float:
    """Precision@k: fraction of the top-``k`` ranked items whose tier is "good".

    ``ranked_tiers`` is the list of EXPECTED tiers ordered by the MODEL's ranking
    (best-first). Precision@k = (# of top-k items with tier in ``good_tiers``) / k',
    where k' = min(k, len(ranked_tiers)). Returns 0.0 for empty input or k <= 0.

    Example: model's top-3 expected tiers are ["A", "B", "C"] with good={A,B}
    -> 2/3 ≈ 0.667.
    """
    if k <= 0 or not ranked_tiers:
        return 0.0
    top = ranked_tiers[:k]
    hits = sum(1 for t in top if t in good_tiers)
    return hits / len(top)


def dcg_at_k(relevances: Sequence[float], k: int) -> float:
    """Discounted Cumulative Gain over the first ``k`` graded relevances.

    DCG@k = sum_{i=1..k} rel_i / log2(i + 1)  (standard, 1-indexed positions).
    """
    if k <= 0:
        return 0.0
    total = 0.0
    for i, rel in enumerate(relevances[:k], start=1):
        total += rel / math.log2(i + 1)
    return total


def ndcg_at_k(ranked_relevances: Sequence[float], k: int) -> float:
    """Normalised DCG@k in [0, 1] (spec Layer 6 ranking metric).

    ``ranked_relevances`` are the graded relevances (e.g. from ``tier_relevance``) in
    the order the MODEL ranked them (best-first). NDCG@k = DCG@k / IDCG@k, where IDCG
    is the DCG of the ideal ordering (relevances sorted descending). Returns 0.0 when
    the ideal DCG is 0 (no relevant items) or for empty input / k <= 0, so the metric
    is always well-defined.

    Example: model order rel=[3,1,2], k=3. DCG = 3/1 + 1/1.585 + 2/2 = 4.6309.
    Ideal = [3,2,1]: IDCG = 3 + 2/1.585 + 1/2 = 4.7619. NDCG ≈ 0.9725.
    """
    if k <= 0 or not ranked_relevances:
        return 0.0
    dcg = dcg_at_k(ranked_relevances, k)
    ideal = dcg_at_k(sorted(ranked_relevances, reverse=True), k)
    if ideal == 0.0:
        return 0.0
    return dcg / ideal


def selection_rate(tiers: Sequence[str], good_tiers: frozenset[str] = DEFAULT_GOOD_TIERS) -> float:
    """Selection rate: fraction of ``tiers`` that are a positive ("good") outcome.

    Returns 0.0 for an empty group (an empty group selects nobody).
    """
    if not tiers:
        return 0.0
    return sum(1 for t in tiers if t in good_tiers) / len(tiers)


def selection_rate_parity(
    groups: dict[str, Sequence[str]],
    good_tiers: frozenset[str] = DEFAULT_GOOD_TIERS,
) -> float | None:
    """Bias-parity helper: min/max selection-rate ratio across groups (the 4/5ths ratio).

    ``groups`` maps a group label -> that group's ranked/assigned tiers. Returns
    min(selectionRate) / max(selectionRate) across the groups — the same adverse-impact
    ratio the disparity audit computes — or ``None`` when it is undefined (fewer than 2
    groups, or every group's max selection rate is 0). A value < 0.8 indicates a
    potential adverse-impact (EEOC 4/5ths) concern.

    This is the eval-set counterpart to ``app.audit.disparity.compute_disparity`` and
    lets the offline eval gate assert that the ranker is not producing disparate
    outcomes across the labelled golden groups.
    """
    if len(groups) < 2:
        return None
    rates = [selection_rate(tiers, good_tiers) for tiers in groups.values()]
    max_rate = max(rates)
    if max_rate == 0.0:
        return None
    return min(rates) / max_rate
