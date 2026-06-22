"""Module 4 — embeddings for the RAG knowledge base (one embed function, two callers).

Both the document pipeline (``app/knowledge/pipeline.py``) and the ``POST /v1/embed``
route go through ``embed_documents`` here, so ingest-time and query-time vectors are
produced by the EXACT same code path and are therefore directly comparable with cosine
similarity.

ONLINE (``OPENAI_API_KEY`` set): ``text-embedding-3-large`` via the OpenAI SDK, FORCING
``settings.embedding_dim`` (default 1536) through the ``dimensions`` request param so
every vector — ingest or query — is the same fixed length. (The spec mentions 3072 dims,
but text-embedding-3-large supports a configurable ``dimensions``; we pin ONE length so
the two ends never mismatch, which would silently break cosine retrieval.)

OFFLINE (no key): a DETERMINISTIC unit vector of the SAME ``embedding_dim`` built from
token hashing — clearly marked via ``EmbedBatch.offline`` — so dev/CI retrieval works
with no network. The fallback is L2-normalised so cosine similarity behaves sensibly, and
it is deterministic (same text -> same vector) so a query embedding can match the chunk
embedding of the same passage.

This module re-uses the project's existing ``cosine_similarity`` (app/embeddings.py)
rather than re-implementing it.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass

import structlog

from ..config import Settings, get_settings

log = structlog.get_logger(__name__)

# Marker appended to the model id when vectors came from the offline fallback, so callers
# (EmbedResponse.model, the pipeline's modelVersion) make the degraded mode visible.
_OFFLINE_SUFFIX = "+offline_fallback"

# Lightweight tokenizer for the offline hashing fallback (NOT a real BPE tokenizer — just
# enough to spread signal across dimensions deterministically).
_WORD_RE = re.compile(r"[A-Za-z0-9]+")


@dataclass(slots=True)
class EmbedBatch:
    """Result of embedding a batch of texts.

    ``vectors`` are all exactly ``dim`` long. ``model`` is the model id (suffixed when the
    offline fallback produced the vectors). ``offline`` is True for the deterministic stub.
    """

    vectors: list[list[float]]
    model: str
    dim: int
    offline: bool


def _build_client(settings: Settings) -> object:
    # Lazy import so the module loads without the SDK installed (offline dev).
    from openai import AsyncOpenAI

    return AsyncOpenAI(api_key=settings.openai_api_key, timeout=settings.llm_timeout_seconds)


def _deterministic_vector(text: str, dim: int) -> list[float]:
    """A deterministic, L2-normalised unit vector of length ``dim`` from token hashing.

    Each token contributes weight to a small set of dimensions chosen by hashing the
    token (signed by a second hash bit), so semantically-overlapping texts share signal
    and cosine similarity is meaningful for dev retrieval. Same input -> same output.
    """
    acc = [0.0] * dim
    tokens = _WORD_RE.findall(text.lower())
    if not tokens:
        # Degenerate: hash the whole (possibly empty) string into one stable direction so
        # we never return an all-zero vector (cosine_similarity treats those as 0.0).
        tokens = [text.strip() or "\x00"]
    for tok in tokens:
        h = hashlib.sha256(tok.encode("utf-8")).digest()
        # Use several byte-windows of the digest so each token touches a few dimensions.
        for i in range(0, 24, 4):
            idx = int.from_bytes(h[i : i + 2], "big") % dim
            sign = 1.0 if h[i + 2] & 0x01 else -1.0
            magnitude = 1.0 + (h[i + 3] / 255.0)  # in [1.0, 2.0]
            acc[idx] += sign * magnitude
    norm = math.sqrt(sum(v * v for v in acc))
    if norm == 0.0:
        # Fall back to a fixed unit basis vector (still deterministic, never all-zero).
        acc[0] = 1.0
        return acc
    return [v / norm for v in acc]


async def embed_documents(
    texts: list[str], *, settings: Settings | None = None
) -> EmbedBatch:
    """Embed ``texts`` into fixed-``dim`` vectors; the single embed entrypoint for Module 4.

    Always returns vectors of length ``settings.embedding_dim``. Online uses
    ``text-embedding-3-large`` with the ``dimensions`` param pinned to that length; offline
    uses the deterministic hashing fallback (``EmbedBatch.offline == True``). Never raises
    for the offline case — the whole RAG path is designed to run with no network.
    """
    settings = settings or get_settings()
    dim = settings.embedding_dim
    if not texts:
        return EmbedBatch(vectors=[], model=settings.embedding_model, dim=dim, offline=not settings.openai_enabled)

    if not settings.openai_enabled:
        log.info("embed_offline_fallback", count=len(texts), dim=dim)
        return EmbedBatch(
            vectors=[_deterministic_vector(t, dim) for t in texts],
            model=f"{settings.embedding_model}{_OFFLINE_SUFFIX}",
            dim=dim,
            offline=True,
        )

    client = _build_client(settings)
    resp = await client.embeddings.create(  # type: ignore[attr-defined]
        model=settings.embedding_model,
        input=texts,
        dimensions=dim,  # FORCE the fixed length so ingest/query vectors always match.
    )
    ordered = sorted(resp.data, key=lambda d: d.index)
    vectors = [list(d.embedding) for d in ordered]
    # Defensive: the API honours ``dimensions``, but never let a length mismatch through.
    for v in vectors:
        if len(v) != dim:
            raise ValueError(
                f"OpenAI returned a {len(v)}-dim vector but {dim} was requested; "
                "ingest/query vectors must share one length for cosine retrieval."
            )
    return EmbedBatch(vectors=vectors, model=settings.embedding_model, dim=dim, offline=False)
