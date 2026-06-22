"""Unit tests for the bias / disparity audit (Module 1 step 6, pure statistics).

Synthetic data with a KNOWN EEOC 4/5ths violation and a clean (parity ~1.0) case,
plus the undefined-ratio edge cases. Exact assertions throughout; no network/LLM.
"""

from __future__ import annotations

from app.audit.disparity import compute_disparity
from app.schemas import DisparityRecord, DisparityRequest


def _records(group: str, tier: str, score: float, count: int) -> list[DisparityRecord]:
    return [DisparityRecord(group=group, score=score, tier=tier) for _ in range(count)]


# ── KNOWN 4/5ths violation ──────────────────────────────────────────────────
def test_known_four_fifths_violation() -> None:
    # Group A: 5/5 selected (rate 1.0). Group B: 2/5 selected (rate 0.4).
    # adverseImpactRatio = 0.4 / 1.0 = 0.4 < 0.8  => violation.
    records = (
        _records("A", "A", 0.90, 5)
        + _records("B", "A", 0.55, 2)  # 2 selected (tier A is a selection tier)
        + _records("B", "C", 0.30, 3)  # 3 not selected
    )
    report = compute_disparity(DisparityRequest(records=records))

    by_group = {g.group: g for g in report.groups}
    assert by_group["A"].n == 5
    assert by_group["A"].selected == 5
    assert by_group["A"].selectionRate == 1.0
    assert by_group["A"].meanScore == 0.90

    assert by_group["B"].n == 5
    assert by_group["B"].selected == 2
    assert by_group["B"].selectionRate == 0.4
    # mean = (2*0.55 + 3*0.30) / 5 = (1.10 + 0.90) / 5 = 0.40
    assert by_group["B"].meanScore == 0.40

    assert report.referenceGroup == "A"  # highest selection rate
    assert report.adverseImpactRatio == 0.4
    assert report.fourFifthsViolation is True
    # spread = 1.0 - 0.4 = 0.6 > 0.10
    assert report.disproportionateFlag is True
    assert report.generatedAt.endswith("+00:00")


# ── CLEAN case (parity) ──────────────────────────────────────────────────────
def test_clean_case_no_violation() -> None:
    # Group A: 3/4 selected (0.75). Group B: 3/4 selected (0.75). ratio = 1.0.
    records = (
        _records("A", "A", 0.80, 3)
        + _records("A", "C", 0.40, 1)
        + _records("B", "B", 0.70, 3)
        + _records("B", "D", 0.40, 1)
    )
    report = compute_disparity(DisparityRequest(records=records))

    by_group = {g.group: g for g in report.groups}
    assert by_group["A"].selectionRate == 0.75
    assert by_group["B"].selectionRate == 0.75

    assert report.adverseImpactRatio == 1.0
    assert report.fourFifthsViolation is False
    # spread = 0.0, not > 0.10.
    assert report.disproportionateFlag is False
    # Tie on selection rate -> alphabetically-first group is the reference.
    assert report.referenceGroup == "A"


# ── disproportionate flag without a full 4/5ths violation ─────────────────────
def test_disproportionate_flag_but_no_four_fifths_violation() -> None:
    # A: 10/10 = 1.0; B: 88/100 = 0.88. ratio = 0.88 >= 0.8 (no violation) but the
    # spread 1.0 - 0.88 = 0.12 > 0.10 => disproportionateFlag True.
    records = (
        _records("A", "A", 0.9, 10)
        + _records("B", "A", 0.8, 88)
        + _records("B", "C", 0.3, 12)
    )
    report = compute_disparity(DisparityRequest(records=records))
    by_group = {g.group: g for g in report.groups}
    assert by_group["B"].selectionRate == 0.88
    assert report.adverseImpactRatio == 0.88
    assert report.fourFifthsViolation is False
    assert report.disproportionateFlag is True


# ── selectionTiers is configurable ────────────────────────────────────────────
def test_selection_tiers_override_counts_only_tier_a() -> None:
    # With selectionTiers=["A"], B-tier candidates are NOT counted as selected.
    records = _records("X", "A", 0.9, 2) + _records("X", "B", 0.7, 2)
    default_report = compute_disparity(DisparityRequest(records=records))
    # Default selection tiers are A and B -> all 4 selected.
    assert default_report.groups[0].selected == 4

    a_only = compute_disparity(DisparityRequest(records=records, selectionTiers=["A"]))
    assert a_only.groups[0].selected == 2
    assert a_only.groups[0].selectionRate == 0.5


# ── undefined-ratio edge cases ────────────────────────────────────────────────
def test_single_group_has_no_ratio() -> None:
    report = compute_disparity(DisparityRequest(records=_records("solo", "A", 0.9, 3)))
    assert report.adverseImpactRatio is None  # nothing to compare against
    assert report.fourFifthsViolation is False
    assert report.disproportionateFlag is False
    assert report.referenceGroup == "solo"


def test_no_selections_anywhere_has_no_ratio() -> None:
    # Two groups but nobody is selected -> max selection rate is 0 -> ratio undefined.
    records = _records("A", "C", 0.3, 2) + _records("B", "D", 0.2, 2)
    report = compute_disparity(DisparityRequest(records=records))
    assert report.adverseImpactRatio is None
    assert report.fourFifthsViolation is False
    assert report.disproportionateFlag is False
