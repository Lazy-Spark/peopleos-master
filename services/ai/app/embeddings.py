"""Embedding helper (OpenAI ``text-embedding-3-large``) with an offline fallback.

Used by experience-relevance scoring (Module 1 step 3). When ``OPENAI_API_KEY`` is
absent the service must still run in dev, so callers fall back to a deterministic
token-overlap similarity (clearly marked) instead of real embeddings — see
``app/scoring/exp_relevance.py``.

The embedding model is fixed by the spec (text-embedding-3-large, 3072 dims). Do NOT
substitute another provider/library.
"""

from __future__ import annotations

import math

import structlog

from .config import Settings, get_settings

log = structlog.get_logger(__name__)


class EmbeddingsUnavailable(RuntimeError):
    """Raised when no OpenAI API key is configured (offline dev)."""


def _build_client(settings: Settings) -> object:
    # Lazy import so the module loads without the SDK installed (offline dev).
    from openai import AsyncOpenAI

    return AsyncOpenAI(api_key=settings.openai_api_key, timeout=settings.llm_timeout_seconds)


async def embed_texts(texts: list[str], settings: Settings | None = None) -> list[list[float]]:
    """Embed a batch of texts with ``text-embedding-3-large``.

    Raises ``EmbeddingsUnavailable`` when offline so the caller can use the
    deterministic token-overlap fallback.
    """
    settings = settings or get_settings()
    if not settings.openai_enabled:
        raise EmbeddingsUnavailable(
            "OPENAI_API_KEY not set — caller should use the token-overlap fallback."
        )
    if not texts:
        return []

    client = _build_client(settings)
    resp = await client.embeddings.create(  # type: ignore[attr-defined]
        model=settings.embedding_model,
        input=texts,
    )
    # SDK returns data sorted by index; sort defensively to be safe.
    ordered = sorted(resp.data, key=lambda d: d.index)
    return [list(d.embedding) for d in ordered]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity in [-1, 1]; returns 0.0 for degenerate vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)
