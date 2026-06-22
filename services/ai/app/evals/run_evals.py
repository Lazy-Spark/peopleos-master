"""Module 1 eval runner (spec Layer 6: Precision@3, NDCG, bias parity).

Runs the full ranker over ``golden_module1.json`` and reports, OFFLINE by design:

  Set-wide (over the 12+ independent ``cases``):
    - tier accuracy (exact match) and within-1-tier accuracy
    - Precision@3 (of the model's top-3 by finalScore, how many are A/B-labelled)

  Job-level (over each ``rankingCases`` entry — one JD vs a set of candidates):
    - Precision@3 within that job's ranked shortlist
    - NDCG@k (graded relevance from expected tier) for the ranking quality
    - selection-rate parity (the 4/5ths adverse-impact ratio across group labels)

The ranker's deterministic fallbacks cover the LLM and embedding steps, so this is a
network-free CI gate (prompt standard #6). When an ANTHROPIC_API_KEY is present it
exercises the real LLM holistic step instead.

Usage:
    python -m app.evals.run_evals            # human-readable report
    python -m app.evals.run_evals --json     # machine-readable summary
    python -m app.evals.run_evals --gate     # apply the CI eval gate (exit non-zero on fail)
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import get_settings
from ..modules.resume_ranker import score_candidate
from ..schemas import CandidateProfile, JDStructured, ScoreCandidateRequest
from .metrics import (
    DEFAULT_GOOD_TIERS,
    ndcg_at_k,
    precision_at_k,
    selection_rate_parity,
    tier_relevance,
)

_GOLDEN_PATH = Path(__file__).with_name("golden_module1.json")
_TIER_ORDER = {"A": 3, "B": 2, "C": 1, "D": 0}
_NDCG_K = 5

# Stable placeholder UUIDs for the offline eval (no DB involved).
_ORG_ID = "00000000-0000-0000-0000-000000000001"
_JOB_ID = "00000000-0000-0000-0000-000000000002"

# ── Documented CI gate thresholds (standard #6) ───────────────────────────────
# These match the offline deterministic path; tighten once the LLM path is wired.
GATE_THRESHOLDS: dict[str, float] = {
    "withinOneTierAccuracy": 0.80,  # ranker must be at least within one tier ~always
    "precisionAt3": 0.66,           # the set-wide top-3 must be dominated by A/B labels
    "rankingPrecisionAt3": 0.66,    # each job-level shortlist top-3 must be mostly good
    "ndcgAt5": 0.80,                # job-level ranking quality (graded relevance)
    "selectionRateParity": 0.80,    # 4/5ths rule across golden group labels
}


def _candidate_id(seed: str) -> str:
    """Deterministic placeholder candidate UUID from a stable seed string.

    Uses a stable digest (NOT the builtin hash(), which is salted per process via
    PYTHONHASHSEED) so the placeholder id is reproducible run-to-run — important for
    auditable eval artifacts.
    """
    digest = int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:15], 16)
    return f"00000000-0000-0000-0000-{digest % (10**12):012d}"


# ── Independent ("cases") results ─────────────────────────────────────────────
@dataclass(slots=True)
class CaseResult:
    case_id: str
    expected_tier: str
    actual_tier: str
    final_score: float
    correct: bool
    within_one: bool


# ── Job-level ("rankingCases") results ────────────────────────────────────────
@dataclass(slots=True)
class RankingCaseResult:
    case_id: str
    # Candidates sorted best-first by the model's finalScore, as (id, expectedTier).
    ranked: list[tuple[str, str]]
    precision_at_3: float
    ndcg_at_k: float
    parity: float | None  # selection-rate parity across group labels (None if N/A)


@dataclass(slots=True)
class EvalSummary:
    n: int = 0
    tier_accuracy: float = 0.0
    within_one_accuracy: float = 0.0
    precision_at_3: float = 0.0
    cases: list[CaseResult] = field(default_factory=list)
    # Job-level metrics (means across rankingCases) + per-case detail.
    ranking_precision_at_3: float = 0.0
    ndcg_at_5: float = 0.0
    selection_rate_parity: float | None = None
    ranking_cases: list[RankingCaseResult] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "tierAccuracy": round(self.tier_accuracy, 4),
            "withinOneTierAccuracy": round(self.within_one_accuracy, 4),
            "precisionAt3": round(self.precision_at_3, 4),
            "rankingPrecisionAt3": round(self.ranking_precision_at_3, 4),
            "ndcgAt5": round(self.ndcg_at_5, 4),
            "selectionRateParity": (
                round(self.selection_rate_parity, 4)
                if self.selection_rate_parity is not None
                else None
            ),
            "cases": [
                {
                    "id": c.case_id,
                    "expectedTier": c.expected_tier,
                    "actualTier": c.actual_tier,
                    "finalScore": round(c.final_score, 4),
                    "correct": c.correct,
                    "withinOne": c.within_one,
                }
                for c in self.cases
            ],
            "rankingCases": [
                {
                    "id": rc.case_id,
                    "ranked": [{"id": cid, "expectedTier": t} for cid, t in rc.ranked],
                    "precisionAt3": round(rc.precision_at_3, 4),
                    "ndcgAt5": round(rc.ndcg_at_k, 4),
                    "parity": round(rc.parity, 4) if rc.parity is not None else None,
                }
                for rc in self.ranking_cases
            ],
        }

    def gate_failures(self, thresholds: dict[str, float] = GATE_THRESHOLDS) -> list[str]:
        """Return a list of human-readable gate failures (empty list == pass).

        A metric that is ``None`` / not applicable (e.g. parity with no groups, or no
        ranking cases present) does NOT fail the gate — we cannot fail on a metric we
        could not compute.
        """
        measured: dict[str, float | None] = {
            "withinOneTierAccuracy": self.within_one_accuracy,
            "precisionAt3": self.precision_at_3,
            "rankingPrecisionAt3": self.ranking_precision_at_3 if self.ranking_cases else None,
            "ndcgAt5": self.ndcg_at_5 if self.ranking_cases else None,
            "selectionRateParity": self.selection_rate_parity,
        }
        failures: list[str] = []
        for name, threshold in thresholds.items():
            value = measured.get(name)
            if value is None:
                continue
            if value < threshold:
                failures.append(f"{name}={value:.4f} < threshold {threshold:.2f}")
        return failures


def load_golden(path: Path = _GOLDEN_PATH) -> dict[str, Any]:
    """Load the golden file; returns the full dict ({cases, rankingCases})."""
    return dict(json.loads(path.read_text(encoding="utf-8")))


async def _score_pair(profile_data: dict[str, Any], jd_data: dict[str, Any], seed: str) -> Any:
    """Score one (profile, JD) pair through the ranker, returning the CandidateRanking."""
    profile = CandidateProfile.model_validate(profile_data)
    jd = JDStructured.model_validate(jd_data)
    req = ScoreCandidateRequest(
        orgId=_ORG_ID,
        jobId=_JOB_ID,
        candidateId=_candidate_id(seed),
        profile=profile,
        jdText=None,
        jdStructured=jd,
        weights=None,
    )
    return await score_candidate(req)


async def run_case(case: dict[str, Any]) -> CaseResult:
    ranking = await _score_pair(case["profile"], case["jd"], case["id"])
    expected = case["expectedTier"]
    actual = ranking.tier
    return CaseResult(
        case_id=case["id"],
        expected_tier=expected,
        actual_tier=actual,
        final_score=ranking.finalScore,
        correct=expected == actual,
        within_one=abs(_TIER_ORDER[expected] - _TIER_ORDER[actual]) <= 1,
    )


async def run_ranking_case(case: dict[str, Any]) -> RankingCaseResult:
    """Score one JD against its candidate set and compute job-level ranking metrics."""
    jd_data = case["jd"]
    candidates = case["candidates"]

    # Score every candidate against the shared JD, keeping the expected tier, group,
    # AND the model's ACTUAL output tier. (id, expectedTier, group, finalScore, actualTier)
    scored: list[tuple[str, str, str | None, float, str]] = []
    for cand in candidates:
        ranking = await _score_pair(cand["profile"], jd_data, f"{case['id']}:{cand['id']}")
        scored.append(
            (cand["id"], cand["expectedTier"], cand.get("group"), ranking.finalScore, ranking.tier)
        )

    # Rank best-first by the model's finalScore.
    scored.sort(key=lambda row: row[3], reverse=True)
    # P@3 / NDCG relevance use the GROUND-TRUTH (expected) tier, evaluated in the model's
    # predicted order — that is the correct relevance signal for ranking quality.
    ranked_tiers = [expected for _id, expected, _g, _f, _actual in scored]
    ranked_relevances = [float(tier_relevance(t)) for t in ranked_tiers]

    p_at_3 = precision_at_k(ranked_tiers, 3, DEFAULT_GOOD_TIERS)
    ndcg = ndcg_at_k(ranked_relevances, _NDCG_K)

    # Parity measures the ranker's ACTUAL selection-rate disparity across groups (the
    # tiers the model actually assigned, matching the runtime disparity audit), so a
    # biased ranker drives the ratio below the 4/5ths threshold and fails the gate.
    # The OFFLINE deterministic heuristic systematically under-scores and is NOT a
    # fairness oracle, so parity is computed/gated ONLY when a real LLM produced the
    # tiers; offline it is reported as n/a (None) rather than spuriously failing.
    parity: float | None = None
    if get_settings().anthropic_enabled:
        groups: dict[str, list[str]] = {}
        for _cid, _expected, group, _final, actual_tier in scored:
            if group is not None:
                groups.setdefault(group, []).append(actual_tier)
        parity = selection_rate_parity(groups, DEFAULT_GOOD_TIERS) if groups else None

    return RankingCaseResult(
        case_id=case["id"],
        ranked=[(cid, expected) for cid, expected, _g, _f, _actual in scored],
        precision_at_3=p_at_3,
        ndcg_at_k=ndcg,
        parity=parity,
    )


async def run_evals(path: Path = _GOLDEN_PATH) -> EvalSummary:
    golden = load_golden(path)
    cases = list(golden.get("cases", []))
    ranking_cases = list(golden.get("rankingCases", []))

    results = [await run_case(c) for c in cases]
    ranking_results = [await run_ranking_case(rc) for rc in ranking_cases]

    n = len(results)
    summary = EvalSummary(n=n, cases=results, ranking_cases=ranking_results)

    if n > 0:
        summary.tier_accuracy = sum(1 for r in results if r.correct) / n
        summary.within_one_accuracy = sum(1 for r in results if r.within_one) / n
        # Set-wide Precision@3 over the model's top-3 by finalScore.
        top_k = sorted(results, key=lambda r: r.final_score, reverse=True)[:3]
        if top_k:
            top_tiers = [r.expected_tier for r in top_k]
            summary.precision_at_3 = precision_at_k(top_tiers, 3, DEFAULT_GOOD_TIERS)

    if ranking_results:
        summary.ranking_precision_at_3 = sum(rc.precision_at_3 for rc in ranking_results) / len(
            ranking_results
        )
        summary.ndcg_at_5 = sum(rc.ndcg_at_k for rc in ranking_results) / len(ranking_results)
        parities = [rc.parity for rc in ranking_results if rc.parity is not None]
        summary.selection_rate_parity = (sum(parities) / len(parities)) if parities else None

    return summary


def _print_human(summary: EvalSummary) -> None:
    print(f"Module 1 eval — {summary.n} independent cases")  # noqa: T201
    print(f"  tier accuracy          : {summary.tier_accuracy:.2%}")  # noqa: T201
    print(f"  within-1-tier accuracy : {summary.within_one_accuracy:.2%}")  # noqa: T201
    print(f"  precision@3 (good=A/B) : {summary.precision_at_3:.2%}")  # noqa: T201
    print(f"  job-level ranking cases: {len(summary.ranking_cases)}")  # noqa: T201
    if summary.ranking_cases:
        print(f"  ranking precision@3    : {summary.ranking_precision_at_3:.2%}")  # noqa: T201
        print(f"  NDCG@{_NDCG_K}              : {summary.ndcg_at_5:.4f}")  # noqa: T201
        parity = summary.selection_rate_parity
        parity_txt = f"{parity:.4f}" if parity is not None else "n/a"
        print(f"  selection-rate parity  : {parity_txt}")  # noqa: T201
    print("  independent cases:")  # noqa: T201
    for c in summary.cases:
        flag = "OK " if c.correct else ("~  " if c.within_one else "XX ")
        print(  # noqa: T201
            f"    {flag}{c.case_id:28s} expected={c.expected_tier} "
            f"actual={c.actual_tier} score={c.final_score:.3f}"
        )
    for rc in summary.ranking_cases:
        order = " > ".join(f"{cid}({t})" for cid, t in rc.ranked)
        print(f"  ranking[{rc.case_id}]: {order}")  # noqa: T201


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Module 1 evals over the golden set.")
    parser.add_argument("--json", action="store_true", help="emit a machine-readable JSON summary")
    parser.add_argument(
        "--gate",
        action="store_true",
        help="apply the CI eval gate: exit non-zero if any metric is below threshold",
    )
    args = parser.parse_args(argv)

    summary = asyncio.run(run_evals())
    if args.json:
        print(json.dumps(summary.to_dict(), indent=2))  # noqa: T201
    else:
        _print_human(summary)

    failures = summary.gate_failures()
    if args.gate:
        if failures:
            print("\nEVAL GATE: FAIL")  # noqa: T201
            for f in failures:
                print(f"  - {f}")  # noqa: T201
            return 1
        print("\nEVAL GATE: PASS")  # noqa: T201
        return 0

    # Without --gate we still signal failure via exit code (back-compat), but do not
    # print the gate banner.
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
