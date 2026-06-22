"""Skill match scoring (Module 1 step 2) — fully deterministic.

Computes coverage of the JD's required skills against the candidate's normalised
skills. Per spec:
  - critical (CRITICAL) skills weight x2, preferred (PREFERRED) skills weight x1
  - fuzzy / synonym match fallback catches near-misses (e.g. "ReactJS" vs "React")

Returns both:
  - ``skillMatchPct``  — Percent [0,100], human-facing coverage % (CandidateRanking)
  - ``skillMatch``     — UnitScore [0,1], the weighted unit score fed to compose

No LLM/network. Synonyms reuse the same alias table as the resume pipeline's skill
normalisation so matching is consistent end-to-end.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..schemas import CandidateProfile, JDStructured
from .synonyms import canonical_key, expand_aliases

# Importance weights (spec Module 1 step 2).
_CRITICAL_WEIGHT = 2.0
_PREFERRED_WEIGHT = 1.0

# Token-overlap threshold for the fuzzy fallback (Jaccard over word tokens).
_FUZZY_THRESHOLD = 0.6


@dataclass(slots=True)
class SkillMatchResult:
    """Output of skill match scoring."""

    skill_match: float  # UnitScore [0,1]
    skill_match_pct: float  # Percent [0,100]
    matched: list[str]  # canonical names of JD skills the candidate has
    missing: list[str]  # canonical names of JD skills the candidate lacks


def _token_set(name: str) -> set[str]:
    return {t for t in canonical_key(name).replace("-", " ").replace(".", " ").split() if t}


def _fuzzy_match(target: str, candidate_keys: set[str], candidate_tokens: list[set[str]]) -> bool:
    """True if ``target`` matches any candidate skill by exact, alias, or token overlap."""
    target_key = canonical_key(target)
    # Exact canonical / alias match.
    if target_key in candidate_keys:
        return True
    for alias in expand_aliases(target):
        if canonical_key(alias) in candidate_keys:
            return True
    # Fuzzy: Jaccard token overlap (catches "React Native" vs "React", etc.).
    target_tokens = _token_set(target)
    if not target_tokens:
        return False
    for cand_tokens in candidate_tokens:
        if not cand_tokens:
            continue
        intersection = len(target_tokens & cand_tokens)
        union = len(target_tokens | cand_tokens)
        if union and (intersection / union) >= _FUZZY_THRESHOLD:
            return True
    return False


def score_skill_match(profile: CandidateProfile, jd: JDStructured) -> SkillMatchResult:
    """Compute weighted required-skill coverage for a candidate against a JD.

    skill_match = (sum of weights of matched skills) / (sum of all weights).
    When the JD lists no required/preferred skills we cannot evaluate coverage and
    return a neutral 0.0 (the holistic step and other components carry the signal).
    """
    candidate_keys = {canonical_key(s.canonicalName) for s in profile.skills}
    # Include raw names so a candidate's pre-normalisation alias still matches.
    for s in profile.skills:
        if s.rawName:
            candidate_keys.add(canonical_key(s.rawName))
    candidate_tokens = [_token_set(s.canonicalName) for s in profile.skills]

    # Build the weighted requirement list: critical (x2) + preferred-in-required (x1)
    # plus the JD's separate preferredSkills[] list (x1).
    requirements: list[tuple[str, float]] = []
    for req in jd.requiredSkills:
        weight = _CRITICAL_WEIGHT if req.importance == "CRITICAL" else _PREFERRED_WEIGHT
        requirements.append((req.canonicalName, weight))
    for pref in jd.preferredSkills:
        requirements.append((pref, _PREFERRED_WEIGHT))

    if not requirements:
        return SkillMatchResult(skill_match=0.0, skill_match_pct=0.0, matched=[], missing=[])

    total_weight = sum(w for _, w in requirements)
    matched_weight = 0.0
    matched: list[str] = []
    missing: list[str] = []

    for name, weight in requirements:
        if _fuzzy_match(name, candidate_keys, candidate_tokens):
            matched_weight += weight
            matched.append(name)
        else:
            missing.append(name)

    skill_match = matched_weight / total_weight if total_weight else 0.0
    skill_match = max(0.0, min(1.0, skill_match))
    return SkillMatchResult(
        skill_match=skill_match,
        skill_match_pct=round(skill_match * 100.0, 2),
        matched=matched,
        missing=missing,
    )
