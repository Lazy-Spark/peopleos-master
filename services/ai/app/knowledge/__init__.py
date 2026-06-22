"""Module 4 — Company knowledge base + Employee HR Chatbot (RAG over policy).

Three AI surfaces, all camelCase end-to-end (mirroring @peopleos/schemas knowledge.ts):
  pipeline    — the document (policy) pipeline (spec Layer 2C): structural parse -> section
                segmentation -> semantic chunking (<=1200 tokens, ~15% overlap) -> per-chunk
                embedding -> SimHash fingerprint for dedup/versioning
  embeddings  — the single embed entrypoint (text-embedding-3-large @ fixed dim, with a
                deterministic offline fallback) used by BOTH the pipeline and /v1/embed
  chat        — the RAG answer (spec Module 4 step 3): grounded ONLY in retrieved policy
                chunks, cites every claim, escalates on missing context / sensitive topics

RAG FAITHFULNESS is central: the chatbot answers ONLY from retrieved policy chunks; if the
answer is not in the context it says so and escalates rather than inventing policy. Sensitive
topics (termination, harassment, salary dispute, discrimination) force escalation to a human.
"""

from __future__ import annotations

from .chat import answer_question, detect_sensitive_topic
from .embeddings import EmbedBatch, embed_documents
from .pipeline import compute_simhash, ingest_policy

__all__ = [
    "EmbedBatch",
    "answer_question",
    "compute_simhash",
    "detect_sensitive_topic",
    "embed_documents",
    "ingest_policy",
]
