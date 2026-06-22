"""Deterministic scoring components for Module 1 (resume ranking).

These are pure/near-pure functions producing UnitScore values in [0,1]:
  - skill_match    (step 2): coverage of required skills (critical x2, preferred x1)
  - exp_relevance  (step 3): embedding cosine vs JD responsibilities + recency decay
  - yoe            (sub-score): years-of-experience match vs JD requiredYoe

They run fully offline (exp_relevance has a token-overlap fallback) so the pipeline
is testable without network access.
"""

from .exp_relevance import ExpRelevanceResult, score_experience_relevance
from .skill_match import SkillMatchResult, score_skill_match
from .yoe import score_yoe_match

__all__ = [
    "ExpRelevanceResult",
    "SkillMatchResult",
    "score_experience_relevance",
    "score_skill_match",
    "score_yoe_match",
]
