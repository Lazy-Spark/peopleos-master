"""Disparity (adverse-impact) computation — Module 1 step 6, pure statistics.

``compute_disparity`` takes a ``DisparityRequest`` (scored candidates each tagged
with an org-supplied demographic group label) and returns a ``DisparityReport``
implementing the EEOC "4/5ths rule" (Uniform Guidelines on Employee Selection
Procedures, 1978). No LLM is involved; the maths is deterministic and auditable.

Definitions (mirroring packages/schemas/src/audit.ts exactly):

  Per group g:
    n              = number of candidates in g
    selected       = number whose tier is in ``selectionTiers`` (default A, B)
    selectionRate  = selected / n            (a "positive outcome" rate)
    meanScore      = mean of finalScore over g

  referenceGroup   = the group with the HIGHEST selectionRate (the comparison base
                     in the 4/5ths analysis; the most-favoured group). Ties resolve
                     to the alphabetically-first group for determinism.
  adverseImpactRatio = min(selectionRate) / max(selectionRate)
                     = None when max selectionRate == 0 (undefined ratio) or when
                       there are fewer than 2 groups (nothing to compare against).
  fourFifthsViolation = adverseImpactRatio < 0.8 (the EEOC 4/5ths threshold). False
                     when the ratio is None (cannot assert a violation we can't compute).
  disproportionateFlag = (max selectionRate - min selectionRate) > 0.10, i.e. the
                     selection-rate spread exceeds 10 percentage points (spec step 6:
                     "> 10% disproportionate flagging rate").

``generatedAt`` is an ISO-8601 UTC timestamp (``datetime.now(timezone.utc).isoformat()``).

Why no protected attributes are stored: the group labels arrive per request and are
never persisted by this service. The report contains only aggregate statistics.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from ..schemas import (
    DisparityReport,
    DisparityRequest,
    GroupStat,
)

# EEOC 4/5ths (80%) rule threshold + the spec's 10-percentage-point spread threshold.
_FOUR_FIFTHS_THRESHOLD = 0.8
_DISPROPORTIONATE_SPREAD = 0.10


def compute_disparity(req: DisparityRequest) -> DisparityReport:
    """Compute an adverse-impact / disparity report (pure stats, no LLM).

    The report is grouped by the supplied demographic label and ordered by group name
    for stable output. See the module docstring for the exact definitions.
    """
    selection_tiers = set(req.selectionTiers)

    # Aggregate per group in a single pass.
    counts: dict[str, int] = defaultdict(int)
    selected: dict[str, int] = defaultdict(int)
    score_sums: dict[str, float] = defaultdict(float)
    for rec in req.records:
        counts[rec.group] += 1
        score_sums[rec.group] += rec.score
        if rec.tier in selection_tiers:
            selected[rec.group] += 1

    groups: list[GroupStat] = []
    for group in sorted(counts):
        n = counts[group]
        sel = selected[group]
        # n is always >= 1 here (the group only exists because a record had it).
        selection_rate = round(sel / n, 6)
        mean_score = round(score_sums[group] / n, 6)
        groups.append(
            GroupStat(
                group=group,
                n=n,
                selected=sel,
                selectionRate=selection_rate,
                meanScore=mean_score,
            )
        )

    rates = [g.selectionRate for g in groups]
    max_rate = max(rates)
    min_rate = min(rates)

    # Reference group = highest selection rate; ties -> alphabetically first. ``groups``
    # is already sorted by name, so the first group achieving max_rate is, by
    # construction, the alphabetically-first of the tied maxima (deterministic).
    # Reference group is only meaningful when someone is actually selected; when no
    # group selects anyone (max_rate == 0) it is left null, mirroring adverseImpactRatio.
    reference_group: str | None = None
    if groups and max_rate > 0.0:
        reference_group = next(g.group for g in groups if g.selectionRate == max_rate)

    # adverseImpactRatio: undefined when no group selects anyone (max==0) or <2 groups.
    adverse_impact_ratio: float | None
    if len(groups) < 2 or max_rate == 0.0:
        adverse_impact_ratio = None
    else:
        adverse_impact_ratio = round(min_rate / max_rate, 6)

    four_fifths_violation = (
        adverse_impact_ratio is not None and adverse_impact_ratio < _FOUR_FIFTHS_THRESHOLD
    )
    disproportionate_flag = (max_rate - min_rate) > _DISPROPORTIONATE_SPREAD

    return DisparityReport(
        groups=groups,
        referenceGroup=reference_group,
        adverseImpactRatio=adverse_impact_ratio,
        fourFifthsViolation=four_fifths_violation,
        disproportionateFlag=disproportionate_flag,
        generatedAt=datetime.now(timezone.utc).isoformat(),
    )
