"""Years-of-experience match scoring (Module 1 sub-score, weight 0.10).

Compares the candidate's total years of experience (``profile.totalYoe``, computed
in the resume pipeline step 4) against the JD's ``requiredYoe``. Fully deterministic;
no LLM/network.

Scoring policy (clamped to UnitScore [0,1]):
  - JD states no requiredYoe          -> neutral 1.0 (cannot penalise on a missing
                                          requirement; signal carried by other comps)
  - candidate totalYoe is unknown     -> conservative 0.5 (mild uncertainty)
  - candidate meets/exceeds requirement-> 1.0
  - candidate below requirement       -> ratio (yoe / requiredYoe), so a candidate
                                          with 3y vs a 5y requirement scores 0.6
  - requiredYoe == 0 (entry level)    -> 1.0 for any candidate
"""

from __future__ import annotations

from ..schemas import CandidateProfile, JDStructured

# When the candidate's YoE is unknown we neither reward nor heavily penalise.
_UNKNOWN_YOE_SCORE = 0.5


def score_yoe_match(profile: CandidateProfile, jd: JDStructured) -> float:
    """Return the YoE match UnitScore in [0,1]."""
    required = jd.requiredYoe

    # No stated requirement -> neutral full credit (cannot evaluate against nothing).
    if required is None:
        return 1.0

    # Entry-level (0 years required) -> anyone qualifies on this axis.
    if required <= 0:
        return 1.0

    candidate_yoe = profile.totalYoe
    if candidate_yoe is None:
        return _UNKNOWN_YOE_SCORE

    ratio = candidate_yoe / required
    return max(0.0, min(1.0, ratio))
