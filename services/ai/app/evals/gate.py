"""CI eval gate for Module 1 (prompt-engineering standard #6: "Eval runs in CI").

Runs the offline golden-set evals and exits NON-ZERO when any metric falls below its
documented threshold (``run_evals.GATE_THRESHOLDS``):

    withinOneTierAccuracy >= 0.80   ranker stays within one tier of the label
    precisionAt3          >= 0.66   set-wide top-3 dominated by good (A/B) labels
    rankingPrecisionAt3   >= 0.66   each job-level shortlist top-3 mostly good
    ndcgAt5               >= 0.80   job-level ranking quality (graded relevance)
    selectionRateParity   >= 0.80   4/5ths adverse-impact ratio across golden groups

These match the OFFLINE deterministic path so CI can gate without network. Tighten
once the real LLM holistic step is wired in the pipeline (the gate then guards prompt
regressions: a prompt change must hold or improve these metrics before merge).

Usage (wire into GitHub Actions on any PR touching prompts/ or the ranker):
    python -m app.evals.gate
    python -m app.evals.gate --json   # also print the machine-readable summary
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from .run_evals import GATE_THRESHOLDS, run_evals


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Module 1 CI eval gate.")
    parser.add_argument(
        "--json", action="store_true", help="print the full JSON summary alongside the verdict"
    )
    args = parser.parse_args(argv)

    summary = asyncio.run(run_evals())
    if args.json:
        print(json.dumps(summary.to_dict(), indent=2))  # noqa: T201

    failures = summary.gate_failures(GATE_THRESHOLDS)
    if failures:
        print("EVAL GATE: FAIL")  # noqa: T201
        for f in failures:
            print(f"  - {f}")  # noqa: T201
        return 1

    print("EVAL GATE: PASS — all Module 1 metrics meet thresholds.")  # noqa: T201
    return 0


if __name__ == "__main__":
    sys.exit(main())
