"""Module 4 / spec Layer 2C — the document (policy) pipeline.

``ingest_policy`` turns a ``PolicyIngestRequest`` (rawText + docType + title) into a
``PolicyIngestResponse`` (semantic chunks + a SimHash + the model version). It implements
the spec's Layer 2C steps that belong to the AI service:

  step 2  STRUCTURAL PARSING — build an H1/H2/H3 section tree from headings (markdown
          ``#``/``##``/``###`` and a few plain-text heuristics: ALL-CAPS lines, "N." /
          "N.N" numbered headings). Each section carries a ``sectionPath`` such as
          "Benefits > Health > Eligibility".
  step 3  SEMANTIC CHUNKING (NOT fixed-size) — segment by section, then within a section
          split at PARAGRAPH boundaries, packing paragraphs into chunks of at most
          ~``MAX_CHUNK_TOKENS`` (1200) with ~``OVERLAP_RATIO`` (15%) token overlap carried
          from the tail of the previous chunk for context preservation. Each chunk records
          ``sectionPath``, ``charStart``/``charEnd`` offsets into the ORIGINAL rawText,
          ``pageNumber`` (None for plain text), ``tokenCount``, and its EMBEDDING.
  step 4  EMBEDDING — every chunk is embedded via the single ``embed_documents`` entry
          point (app/knowledge/embeddings.py), so chunk and query vectors are comparable.
  step 5  DEDUP / VERSIONING — a SimHash fingerprint of the whole document is computed so
          the API can detect superseded versions (near-duplicate prior uploads).

Retrieval, Pinecone/Neo4j indexing, table extraction, and cross-reference resolution are
out of scope for this service (the API owns the vector store + graph); we produce the
chunks + vectors + fingerprint it persists.

OFFLINE: chunking + SimHash are pure-Python and never need the network; only the chunk
embeddings degrade to the deterministic fallback (see embeddings.py), in which case the
returned ``modelVersion`` is suffixed ``+offline_fallback``.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

import structlog

from ..config import Settings, get_settings
from ..schemas import DocumentChunkData, PolicyIngestRequest, PolicyIngestResponse
from .embeddings import embed_documents
from .tokens import estimate_tokens, take_overlap_tail

log = structlog.get_logger(__name__)

# Spec Layer 2C step 3: "Max 1200 tokens per chunk", "15% overlap at chunk boundaries".
MAX_CHUNK_TOKENS = 1200
OVERLAP_RATIO = 0.15
# Reserve headroom for the overlap prefix: paragraphs are packed/split against the
# CONTENT budget so that, even when the ~OVERLAP_RATIO tail of the previous chunk is
# prepended to a fresh chunk, the emitted chunk never exceeds MAX_CHUNK_TOKENS.
_OVERLAP_BUDGET = int(MAX_CHUNK_TOKENS * OVERLAP_RATIO)
_CONTENT_BUDGET = MAX_CHUNK_TOKENS - _OVERLAP_BUDGET

# ── Heading detection (structural parse, step 2) ──────────────────────────────
# Markdown ATX headings: leading #'s give the level directly (clamped to H1-H3).
_MD_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
# Numbered headings like "1." (H1), "1.2" (H2), "1.2.3" (H3) followed by a title.
_NUMBERED_HEADING_RE = re.compile(r"^\s*(\d+(?:\.\d+)*)\.?\s+(\S.*\S|\S)\s*$")
# Heuristic plain-text heading: a short ALL-CAPS / Title-Case line with no terminal
# punctuation, treated as an H1/H2 by length. Used only when no markdown headings exist.
_TERMINAL_PUNCT = (".", ":", ";", ",", "!", "?")


@dataclass(slots=True)
class _Section:
    """A parsed section: its heading path + the body text + char span in the source."""

    path: list[str]
    char_start: int
    char_end: int
    body: str


@dataclass(slots=True)
class _HeadingLine:
    level: int  # 1..3
    title: str
    line_start: int  # char offset of the line in the source
    line_end: int  # char offset just past the line's newline


def _classify_heading(line: str, *, markdown_present: bool) -> tuple[int, str] | None:
    """Return ``(level, title)`` if ``line`` is a heading, else None.

    Levels are clamped to 1..3 (the spec's H1/H2/H3 tree). When the document uses markdown
    headings we trust ONLY those (plus numbered headings); otherwise we fall back to the
    ALL-CAPS plain-text heuristic so untagged policy docs still get a section tree.
    """
    stripped = line.strip()
    if not stripped:
        return None

    md = _MD_HEADING_RE.match(line)
    if md:
        level = min(len(md.group(1)), 3)
        return level, md.group(2).strip()

    num = _NUMBERED_HEADING_RE.match(line)
    if num:
        depth = num.group(1).count(".") + 1
        level = min(depth, 3)
        # Keep the number in the title so "3.2 Eligibility" stays human-readable.
        return level, stripped

    if not markdown_present:
        # Plain-text heuristic: short, no terminal punctuation, looks like a title.
        words = stripped.split()
        if 1 <= len(words) <= 9 and not stripped.endswith(_TERMINAL_PUNCT):
            letters = [c for c in stripped if c.isalpha()]
            is_caps = bool(letters) and all(c.isupper() for c in letters)
            is_title = stripped[0].isupper() and not stripped.endswith(_TERMINAL_PUNCT)
            if is_caps:
                return 1, stripped
            if is_title and len(words) <= 6:
                return 2, stripped
    return None


def _find_headings(text: str) -> list[_HeadingLine]:
    """Scan the source for heading lines, recording each line's char span."""
    markdown_present = bool(_MD_HEADING_RE.search(text))
    headings: list[_HeadingLine] = []
    offset = 0
    for raw_line in text.splitlines(keepends=True):
        line = raw_line.rstrip("\n")
        cls = _classify_heading(line, markdown_present=markdown_present)
        if cls is not None:
            level, title = cls
            headings.append(
                _HeadingLine(level=level, title=title, line_start=offset, line_end=offset + len(raw_line))
            )
        offset += len(raw_line)
    return headings


def parse_sections(text: str, *, doc_title: str) -> list[_Section]:
    """Build the H1/H2/H3 section tree and segment the document body by section.

    Each ``_Section`` holds the heading PATH (e.g. ["Benefits", "Health", "Eligibility"])
    prefixed by the document title, the body text between this heading and the next, and
    the char span of that body in the ORIGINAL text. Content before the first heading (a
    preamble) becomes a section under the document title alone.
    """
    headings = _find_headings(text)
    sections: list[_Section] = []

    # Preamble: any content before the first heading.
    first_start = headings[0].line_start if headings else len(text)
    preamble = text[:first_start]
    if preamble.strip():
        sections.append(
            _Section(path=[doc_title], char_start=0, char_end=first_start, body=preamble)
        )

    # Maintain a running heading stack to compose the path.
    stack: list[tuple[int, str]] = []  # (level, title)
    for i, h in enumerate(headings):
        # Pop deeper-or-equal levels so a new H2 replaces the prior H2/H3, etc.
        while stack and stack[-1][0] >= h.level:
            stack.pop()
        stack.append((h.level, h.title))
        path = [doc_title, *(title for _level, title in stack)]

        body_start = h.line_end
        body_end = headings[i + 1].line_start if i + 1 < len(headings) else len(text)
        body = text[body_start:body_end]
        sections.append(
            _Section(path=path, char_start=body_start, char_end=body_end, body=body)
        )

    if not sections:
        # No headings and no preamble (e.g. whitespace-only) — emit one whole-doc section.
        sections.append(_Section(path=[doc_title], char_start=0, char_end=len(text), body=text))
    return sections


@dataclass(slots=True)
class _Paragraph:
    text: str
    char_start: int
    char_end: int


# Paragraph boundary: a blank line (one or more newlines surrounded by optional spaces).
_PARA_SPLIT_RE = re.compile(r"\n[ \t]*\n")


def _split_paragraphs(section: _Section) -> list[_Paragraph]:
    """Split a section body into paragraphs, tracking char offsets in the source.

    We split on blank lines; a section with no blank lines yields a single paragraph. Empty
    fragments are dropped but their offsets are still accounted for so spans stay accurate.
    """
    paras: list[_Paragraph] = []
    pos = section.char_start
    body = section.body
    cursor = 0
    for match in _PARA_SPLIT_RE.finditer(body):
        frag = body[cursor : match.start()]
        if frag.strip():
            start = pos + cursor
            paras.append(_Paragraph(text=frag, char_start=start, char_end=start + len(frag)))
        cursor = match.end()
    # Trailing fragment after the last blank line.
    frag = body[cursor:]
    if frag.strip():
        start = pos + cursor
        paras.append(_Paragraph(text=frag, char_start=start, char_end=start + len(frag)))
    return paras


@dataclass(slots=True)
class _PendingChunk:
    """A chunk being assembled within one section (text accumulates by paragraph)."""

    section_path: str
    parts: list[str] = field(default_factory=list)
    char_start: int | None = None
    char_end: int | None = None
    overlap_prefix: str = ""  # carried tail of the previous chunk (for ~15% overlap)

    def token_count(self) -> int:
        return estimate_tokens(self.text())

    def text(self) -> str:
        joined = "\n\n".join(self.parts)
        return f"{self.overlap_prefix}\n\n{joined}".strip() if self.overlap_prefix else joined

    def is_empty(self) -> bool:
        return not self.parts


def _hard_split_paragraph(para: _Paragraph) -> list[_Paragraph]:
    """Split a single oversized paragraph (> MAX_CHUNK_TOKENS) at sentence boundaries.

    A semantic-first chunker still must not emit a chunk that blows the token budget. We
    split on sentence boundaries, accumulating sentences until the budget is hit, keeping
    char offsets accurate.
    """
    # Split against the CONTENT budget (MAX minus overlap headroom): a piece + the
    # overlap prefix it may later carry must still fit MAX_CHUNK_TOKENS.
    if estimate_tokens(para.text) <= _CONTENT_BUDGET:
        return [para]
    pieces: list[_Paragraph] = []
    sentence_re = re.compile(r"(?<=[.!?])\s+")
    cursor = 0
    buf_start = 0
    buf: list[str] = []
    text = para.text
    spans: list[tuple[int, int]] = []
    last = 0
    for m in sentence_re.finditer(text):
        spans.append((last, m.start()))
        last = m.end()
    spans.append((last, len(text)))

    for s, e in spans:
        sentence = text[s:e]
        candidate = (text[buf_start : e]) if buf else sentence
        if buf and estimate_tokens(candidate) > _CONTENT_BUDGET:
            frag = text[buf_start:cursor]
            pieces.append(
                _Paragraph(
                    text=frag,
                    char_start=para.char_start + buf_start,
                    char_end=para.char_start + cursor,
                )
            )
            buf = [sentence]
            buf_start = s
        else:
            if not buf:
                buf_start = s
            buf.append(sentence)
        cursor = e
    if buf:
        frag = text[buf_start:cursor]
        pieces.append(
            _Paragraph(
                text=frag,
                char_start=para.char_start + buf_start,
                char_end=para.char_start + cursor,
            )
        )
    return pieces or [para]


def chunk_sections(sections: list[_Section]) -> list[DocumentChunkData]:
    """Semantic chunking (step 3): pack paragraphs into <= MAX_CHUNK_TOKENS chunks.

    Boundaries are respected hardest-first: never merge across SECTIONS; within a section,
    split at PARAGRAPH boundaries; only a single paragraph that alone exceeds the budget is
    sentence-split. Consecutive chunks carry ~OVERLAP_RATIO of the previous chunk's tail as
    an overlap prefix for context preservation. ``embedding`` is left empty here and filled
    by ``ingest_policy`` in one batched embed call.
    """
    chunks: list[DocumentChunkData] = []

    def flush(pending: _PendingChunk) -> str:
        """Emit a chunk and return its tail text to seed the next chunk's overlap."""
        if pending.is_empty():
            return ""
        text = pending.text()
        chunks.append(
            DocumentChunkData(
                sectionPath=pending.section_path,
                text=text,
                charStart=pending.char_start or 0,
                charEnd=pending.char_end or 0,
                pageNumber=None,  # plain text has no pages (spec: null for text)
                tokenCount=estimate_tokens(text),
                embedding=[],  # filled by the caller in a batched embed
            )
        )
        overlap_tokens = max(1, int(MAX_CHUNK_TOKENS * OVERLAP_RATIO))
        return take_overlap_tail(text, overlap_tokens)

    for section in sections:
        section_path = " > ".join(section.path)
        paragraphs: list[_Paragraph] = []
        for para in _split_paragraphs(section):
            paragraphs.extend(_hard_split_paragraph(para))
        if not paragraphs:
            continue

        pending = _PendingChunk(section_path=section_path)
        for para in paragraphs:
            # Would adding this paragraph exceed the budget? If the chunk already has
            # content, flush first (paragraph boundary), then start a fresh chunk that
            # carries the overlap tail of the one we just flushed.
            tentative = _PendingChunk(
                section_path=section_path,
                parts=[*pending.parts, para.text],
                char_start=pending.char_start if pending.char_start is not None else para.char_start,
                char_end=para.char_end,
                overlap_prefix=pending.overlap_prefix,
            )
            if not pending.is_empty() and tentative.token_count() > MAX_CHUNK_TOKENS:
                tail = flush(pending)
                pending = _PendingChunk(
                    section_path=section_path,
                    parts=[para.text],
                    char_start=para.char_start,
                    char_end=para.char_end,
                    overlap_prefix=tail,
                )
            else:
                if pending.char_start is None:
                    pending.char_start = para.char_start
                pending.parts.append(para.text)
                pending.char_end = para.char_end
        flush(pending)

    return chunks


# ── SimHash (step 5: dedup / versioning) ──────────────────────────────────────
_SIMHASH_BITS = 64
_FEATURE_RE = re.compile(r"[a-z0-9]+")


def compute_simhash(text: str) -> str:
    """64-bit SimHash fingerprint of the document (hex string).

    Token-shingle SimHash: lowercase word tokens are the features, each hashed to 64 bits;
    bit positions are summed (+1 if set, -1 if clear) across all features, then the sign of
    each accumulator gives the fingerprint bit. Near-duplicate documents (a new version of
    the same policy) produce fingerprints with small Hamming distance, which the API uses to
    detect superseded versions. Returned zero-padded to 16 hex chars.
    """
    tokens = _FEATURE_RE.findall(text.lower())
    if not tokens:
        return "0" * (_SIMHASH_BITS // 4)
    acc = [0] * _SIMHASH_BITS
    for tok in tokens:
        h = int.from_bytes(hashlib.blake2b(tok.encode("utf-8"), digest_size=8).digest(), "big")
        for bit in range(_SIMHASH_BITS):
            acc[bit] += 1 if (h >> bit) & 1 else -1
    fingerprint = 0
    for bit in range(_SIMHASH_BITS):
        if acc[bit] > 0:
            fingerprint |= 1 << bit
    return f"{fingerprint:0{_SIMHASH_BITS // 4}x}"


async def ingest_policy(
    req: PolicyIngestRequest, *, settings: Settings | None = None
) -> PolicyIngestResponse:
    """Run the document pipeline: parse -> segment -> chunk -> embed -> fingerprint."""
    settings = settings or get_settings()

    sections = parse_sections(req.rawText, doc_title=req.title)
    chunks = chunk_sections(sections)

    if chunks:
        batch = await embed_documents([c.text for c in chunks], settings=settings)
        for chunk, vector in zip(chunks, batch.vectors, strict=True):
            chunk.embedding = vector
        offline = batch.offline
    else:
        offline = not settings.openai_enabled

    simhash = compute_simhash(req.rawText)
    model_version = (
        f"{settings.embedding_model}+offline_fallback" if offline else settings.embedding_model
    )
    log.info(
        "policy_ingested",
        orgId=req.orgId,
        docId=req.docId,
        docType=req.docType,
        chunkCount=len(chunks),
        offline=offline,
    )
    return PolicyIngestResponse(chunks=chunks, simhash=simhash, modelVersion=model_version)
