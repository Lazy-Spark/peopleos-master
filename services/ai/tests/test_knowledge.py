"""Unit tests for Module 4 — Company knowledge base + Employee HR Chatbot (RAG).

All tests run WITHOUT network:
  - the document pipeline produces SEMANTIC chunks that respect the max-token bound,
    carry ~15% overlap across boundaries, and record an H1>H2>H3 sectionPath;
  - the embed function is DETERMINISTIC offline and emits vectors of the configured
    fixed dim (so ingest-time and query-time vectors are comparable);
  - the SimHash fingerprint is stable and gives near-duplicate documents a small
    Hamming distance (dedup/versioning);
  - the RAG chat answer cites ONLY provided chunks (drops ungrounded citations),
    ESCALATES when the context is empty, and ESCALATES on a sensitive-topic query
    (termination / harassment / salary dispute / discrimination), all via the offline
    deterministic fallback (no ANTHROPIC_API_KEY) + the deterministic backstops.
"""

from __future__ import annotations

import math

import pytest
from app.config import Settings
from app.knowledge.chat import answer_question, detect_sensitive_topic
from app.knowledge.embeddings import embed_documents
from app.knowledge.pipeline import (
    MAX_CHUNK_TOKENS,
    OVERLAP_RATIO,
    chunk_sections,
    compute_simhash,
    ingest_policy,
    parse_sections,
)
from app.knowledge.tokens import estimate_tokens, take_overlap_tail
from app.schemas import (
    ChatAnswerRequest,
    Citation,
    PolicyIngestRequest,
    RetrievedChunk,
)

_ORG = "00000000-0000-0000-0000-000000000001"
_DOC = "00000000-0000-0000-0000-000000000020"


def _offline_settings() -> Settings:
    """Settings with no Anthropic/OpenAI keys (forces both offline fallbacks)."""
    return Settings(anthropic_api_key=None, openai_api_key=None)


def _tokens(text: str) -> list[str]:
    import re

    return re.findall(r"[A-Za-z0-9]+", text.lower())


_STRUCTURED_DOC = """# Benefits

Overview of company benefits for all staff.

## Health

The company health plan covers medical, dental, and vision.

### Eligibility

You are eligible for the health plan after 30 days of continuous employment.

## Paid Time Off

Employees in EU locations accrue 28 days of paid annual leave per year. US employees
accrue 20 days. Leave accrues monthly and unused days carry over up to 5 days.
"""


# ── Document pipeline: structural parse + sectionPath ─────────────────────────
def test_parse_sections_builds_h1_h2_h3_path() -> None:
    sections = parse_sections(_STRUCTURED_DOC, doc_title="Employee Handbook")
    paths = {" > ".join(s.path) for s in sections}
    assert "Employee Handbook > Benefits > Health > Eligibility" in paths
    assert "Employee Handbook > Benefits > Paid Time Off" in paths


def test_chunks_carry_section_path_and_offsets() -> None:
    sections = parse_sections(_STRUCTURED_DOC, doc_title="Employee Handbook")
    chunks = chunk_sections(sections)
    assert chunks
    for c in chunks:
        assert c.sectionPath  # non-empty " > "-joined path
        assert c.charStart <= c.charEnd
        assert c.pageNumber is None  # plain text has no pages
        assert c.tokenCount >= 0
    elig = [c for c in chunks if "Eligibility" in c.sectionPath]
    assert elig, "eligibility section should produce a chunk"
    assert "30 days" in elig[0].text


# ── Document pipeline: max-token bound + ~15% overlap ─────────────────────────
def _long_single_section_doc() -> str:
    para = (
        "This is sentence {i} of the comprehensive corporate travel and expense "
        "reimbursement policy, covering airfare, lodging, meals, ground transport, and "
        "incidental costs that employees may claim back through the finance portal. "
    )
    body = "\n\n".join(para.format(i=i) for i in range(140))
    return "# Travel and Expense Policy\n\n" + body


def test_chunking_respects_max_token_bound() -> None:
    sections = parse_sections(_long_single_section_doc(), doc_title="Handbook")
    chunks = chunk_sections(sections)
    assert len(chunks) >= 2, "a long document must be split into multiple chunks"
    for c in chunks:
        assert c.tokenCount <= MAX_CHUNK_TOKENS, (
            f"chunk exceeds the {MAX_CHUNK_TOKENS}-token bound: {c.tokenCount}"
        )


def test_chunking_carries_overlap_between_chunks() -> None:
    sections = parse_sections(_long_single_section_doc(), doc_title="Handbook")
    chunks = chunk_sections(sections)
    assert len(chunks) >= 2
    # The head of chunk N+1 should share words with the tail of chunk N (context overlap).
    tail_words = set(_tokens(chunks[0].text)[-40:])
    head_words = _tokens(chunks[1].text)[:40]
    overlap = sum(1 for w in head_words if w in tail_words)
    assert overlap > 0, "consecutive chunks must carry an overlap prefix"


def test_overlap_ratio_is_15_percent() -> None:
    # The configured overlap target is ~15% of the chunk budget (spec Layer 2C step 3).
    assert pytest.approx(0.15) == OVERLAP_RATIO


def test_take_overlap_tail_returns_clean_suffix() -> None:
    text = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
    tail = take_overlap_tail(text, 3)
    assert tail
    assert text.endswith(tail)
    assert take_overlap_tail("anything here", 0) == ""


def test_estimate_tokens_is_conservative() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("   ") == 0
    # ~1000 words should estimate at least ~1000 tokens (never under-counts prose).
    assert estimate_tokens("word " * 1000) >= 1000


# ── Document pipeline: SimHash dedup/versioning ───────────────────────────────
def test_simhash_is_stable_and_fixed_length() -> None:
    text = "The company offers 28 days of paid annual leave per year to all staff."
    a = compute_simhash(text)
    b = compute_simhash(text)
    assert a == b
    assert len(a) == 16  # 64-bit fingerprint as hex


def test_simhash_near_duplicate_has_small_hamming_distance() -> None:
    base = "The company offers 28 days of paid annual leave per year to all staff."
    near = "The company offers 28 days of paid annual leave each year to all staff members."
    far = "Our information security policy mandates multi-factor authentication on all systems."

    def hamming(x: str, y: str) -> int:
        return bin(int(x, 16) ^ int(y, 16)).count("1")

    d_near = hamming(compute_simhash(base), compute_simhash(near))
    d_far = hamming(compute_simhash(base), compute_simhash(far))
    assert d_near < d_far, (d_near, d_far)


# ── Embeddings: deterministic offline + correct dim ───────────────────────────
@pytest.mark.asyncio
async def test_embed_offline_is_deterministic_and_correct_dim() -> None:
    settings = _offline_settings()
    texts = ["annual paid time off entitlement", "health plan eligibility rules"]
    a = await embed_documents(texts, settings=settings)
    b = await embed_documents(texts, settings=settings)
    assert a.offline is True
    assert a.dim == settings.embedding_dim
    assert all(len(v) == settings.embedding_dim for v in a.vectors)
    # Deterministic: same input -> identical vectors.
    assert a.vectors == b.vectors
    # Unit-normalised (cosine-friendly) and never all-zero.
    for v in a.vectors:
        assert abs(math.sqrt(sum(x * x for x in v)) - 1.0) < 1e-6
        assert any(x != 0.0 for x in v)


@pytest.mark.asyncio
async def test_embed_offline_model_id_is_marked() -> None:
    a = await embed_documents(["x"], settings=_offline_settings())
    assert a.model.endswith("+offline_fallback")


@pytest.mark.asyncio
async def test_pipeline_embeds_chunks_at_fixed_dim_offline() -> None:
    settings = _offline_settings()
    req = PolicyIngestRequest(
        orgId=_ORG, docId=_DOC, docType="HANDBOOK", title="Employee Handbook",
        rawText=_STRUCTURED_DOC,
    )
    resp = await ingest_policy(req, settings=settings)
    assert resp.chunks
    assert resp.simhash and len(resp.simhash) == 16
    assert resp.modelVersion.endswith("+offline_fallback")
    for c in resp.chunks:
        assert len(c.embedding) == settings.embedding_dim
        assert c.tokenCount <= MAX_CHUNK_TOKENS


# ── RAG chat: grounding + escalation ──────────────────────────────────────────
def _chunk(doc_id: str, title: str, section: str, text: str) -> RetrievedChunk:
    return RetrievedChunk(
        docId=doc_id, docTitle=title, sectionPath=section, text=text,
        effectiveDate="2024-01-01", score=0.9,
    )


@pytest.mark.asyncio
async def test_chat_cites_only_provided_chunks() -> None:
    settings = _offline_settings()
    chunk = _chunk(
        "11111111-1111-1111-1111-111111111111", "Employee Handbook",
        "Benefits > Paid Time Off > Annual Leave",
        "EU employees accrue 28 days of paid annual leave per year.",
    )
    req = ChatAnswerRequest(
        orgId=_ORG, query="How many vacation days do I get?", candidateChunks=[chunk],
    )
    resp = await answer_question(req, settings=settings)
    allowed = {chunk.docId}
    assert resp.citations, "a grounded chunk should produce at least one citation"
    for cit in resp.citations:
        assert cit.docId in allowed, "citations must reference only provided chunks"
    assert resp.modelVersion.endswith("+offline_fallback")


@pytest.mark.asyncio
async def test_chat_drops_ungrounded_citations() -> None:
    # Sanity on the grounding backstop itself: a citation to an unknown doc is dropped.
    from app.knowledge.chat import _ground_citations

    provided = [_chunk("doc-known", "Handbook", "A > B", "text")]
    cits = [
        Citation(docId="doc-known", docTitle="Handbook", sectionPath="A > B", effectiveDate=None),
        Citation(docId="doc-UNKNOWN", docTitle="Fake", sectionPath="X", effectiveDate=None),
    ]
    grounded = _ground_citations(cits, provided)
    assert [c.docId for c in grounded] == ["doc-known"]


@pytest.mark.asyncio
async def test_chat_escalates_when_context_empty() -> None:
    settings = _offline_settings()
    req = ChatAnswerRequest(
        orgId=_ORG, query="What is the reimbursement limit for a standing desk?",
        candidateChunks=[],
    )
    resp = await answer_question(req, settings=settings)
    assert resp.escalate is True
    assert resp.confidence == "low"
    assert resp.escalationReason
    assert resp.citations == []


@pytest.mark.asyncio
async def test_chat_escalates_on_sensitive_topic() -> None:
    settings = _offline_settings()
    # A sensitive topic must escalate EVEN when a relevant policy chunk is present.
    chunk = _chunk(
        "33333333-3333-3333-3333-333333333333", "Code of Conduct",
        "Workplace Conduct > Anti-Harassment > Reporting",
        "The company prohibits harassment; reports are investigated confidentially.",
    )
    req = ChatAnswerRequest(
        orgId=_ORG,
        query="A coworker keeps making inappropriate comments; I want to report harassment.",
        candidateChunks=[chunk],
    )
    resp = await answer_question(req, settings=settings)
    assert resp.escalate is True
    assert resp.sensitiveTopic == "harassment"
    assert resp.intent == "ESCALATE"
    assert resp.escalationReason


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("I'm worried I'm about to be fired", "termination"),
        ("Is this harassment from my manager?", "harassment"),
        ("I think I'm being underpaid versus my offer", "salary_dispute"),
        ("I was treated unfairly because of my age", "discrimination"),
        ("How do I request parental leave?", None),
        ("What are my PTO days?", None),
    ],
)
def test_detect_sensitive_topic(query: str, expected: str | None) -> None:
    assert detect_sensitive_topic(query) == expected
