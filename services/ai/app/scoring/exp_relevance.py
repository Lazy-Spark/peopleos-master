"""Experience-relevance scoring (Module 1 step 3).

Per spec:
  - embed each work-experience description + the JD responsibilities
    (OpenAI ``text-embedding-3-large``)
  - cosine similarity per experience -> relevance score
  - weight by recency: experience that ended 3+ years ago decays by x0.7

OFFLINE FALLBACK (clearly marked): when ``OPENAI_API_KEY`` is absent we cannot call
the embedding API, so we fall back to a deterministic Jaccard token-overlap
similarity between each experience description and the concatenated JD
responsibilities. This keeps the full pipeline runnable offline in dev. The
returned ``method`` field records which path was taken (for the eval/audit trail).

The aggregate score is a recency-weighted average of per-experience similarities,
clamped to UnitScore [0,1].
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from ..config import Settings, get_settings
from ..embeddings import EmbeddingsUnavailable, cosine_similarity, embed_texts
from ..schemas import CandidateProfile, JDStructured

# Recency decay (spec step 3): experience ending 3+ years ago is multiplied by 0.7.
_RECENCY_CUTOFF_YEARS = 3
_RECENCY_DECAY = 0.7

_WORD_RE = re.compile(r"[a-z0-9]+")
# Tiny stop-word set so token overlap is about content, not glue words.
_STOPWORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at",
        "by", "from", "as", "is", "are", "was", "were", "be", "this", "that", "our",
        "we", "you", "will", "build", "work", "working", "using", "use", "used",
    }
)


@dataclass(slots=True)
class ExpRelevanceResult:
    """Output of experience-relevance scoring."""

    exp_relevance: float  # UnitScore [0,1]
    per_experience: list[float] = field(default_factory=list)  # decay-applied scores
    method: str = "embedding"  # "embedding" | "token_overlap_fallback"


def _tokens(text: str) -> set[str]:
    return {t for t in _WORD_RE.findall(text.lower()) if t not in _STOPWORDS and len(t) > 1}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _parse_year(iso_date: str | None) -> int | None:
    """Extract the year from an ISO date (YYYY-MM-DD); None if unparseable."""
    if not iso_date:
        return None
    try:
        return int(iso_date[:4])
    except (ValueError, TypeError):
        return None


def _recency_weight(exp_end_iso: str | None, is_current: bool, today: date) -> float:
    """1.0 for recent/current experience; 0.7 once it ended 3+ years ago."""
    if is_current or exp_end_iso is None:
        return 1.0
    end_year = _parse_year(exp_end_iso)
    if end_year is None:
        return 1.0
    years_ago = today.year - end_year
    return _RECENCY_DECAY if years_ago >= _RECENCY_CUTOFF_YEARS else 1.0


def _jd_responsibility_text(jd: JDStructured) -> str:
    """Concatenate the JD signals that describe the work to be done."""
    parts: list[str] = list(jd.keyResponsibilities)
    parts.extend(rs.canonicalName for rs in jd.requiredSkills)
    parts.extend(jd.preferredSkills)
    if jd.teamContext:
        parts.append(jd.teamContext)
    return " . ".join(p for p in parts if p)


async def score_experience_relevance(
    profile: CandidateProfile,
    jd: JDStructured,
    *,
    settings: Settings | None = None,
    today: date | None = None,
) -> ExpRelevanceResult:
    """Compute recency-weighted experience relevance vs the JD responsibilities.

    Uses real embeddings when ``OPENAI_API_KEY`` is set, otherwise the deterministic
    token-overlap fallback. Returns a neutral 0.0 when there is nothing to compare.
    """
    settings = settings or get_settings()
    today = today or date.today()

    experiences = [e for e in profile.experience if (e.description or "").strip()]
    jd_text = _jd_responsibility_text(jd).strip()

    # Nothing to compare against -> neutral; other components carry the signal.
    if not experiences or not jd_text:
        return ExpRelevanceResult(exp_relevance=0.0, per_experience=[], method="none")

    exp_texts = [f"{e.title} {e.company}. {e.description or ''}".strip() for e in experiences]

    similarities: list[float]
    method: str
    try:
        # Embed JD first, then each experience, in one batch call.
        vectors = await embed_texts([jd_text, *exp_texts], settings=settings)
        jd_vec, exp_vecs = vectors[0], vectors[1:]
        # Cosine is in [-1,1]; clamp negatives to 0 so they don't drag the mean below 0.
        similarities = [max(0.0, cosine_similarity(jd_vec, v)) for v in exp_vecs]
        method = "embedding"
    except EmbeddingsUnavailable:
        # OFFLINE FALLBACK — deterministic token overlap, clearly marked.
        jd_tokens = _tokens(jd_text)
        similarities = [_jaccard(_tokens(t), jd_tokens) for t in exp_texts]
        method = "token_overlap_fallback"

    # Apply recency decay per experience, then take a weight-normalised mean.
    weighted_scores: list[float] = []
    total_weight = 0.0
    weighted_sum = 0.0
    for exp, sim in zip(experiences, similarities, strict=True):
        weight = _recency_weight(exp.endDate, exp.isCurrent, today)
        decayed = sim * weight
        weighted_scores.append(round(decayed, 4))
        weighted_sum += decayed
        total_weight += weight

    aggregate = weighted_sum / total_weight if total_weight else 0.0
    aggregate = max(0.0, min(1.0, aggregate))
    return ExpRelevanceResult(
        exp_relevance=round(aggregate, 4),
        per_experience=weighted_scores,
        method=method,
    )
