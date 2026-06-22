"""Token estimation for the document pipeline (no network, no tiktoken dependency).

The semantic chunker needs a token budget (spec Layer 2C: "Max 1200 tokens per chunk")
but the service must run fully offline with no model-specific tokenizer installed. We use
a deterministic, conservative estimator calibrated to typical English prose for the
OpenAI/Anthropic BPE families: roughly ~4 characters or ~0.75 words per token. We take the
MAX of a char-based and a word-based estimate so we never UNDER-count (under-counting would
let a chunk exceed the real budget). This is intentionally simple and dependency-free; if a
real tokenizer is wired later it can replace ``estimate_tokens`` without touching callers.
"""

from __future__ import annotations

import re

_WORD_RE = re.compile(r"\S+")

# Calibration constants (English prose, BPE-family tokenizers).
_CHARS_PER_TOKEN = 4.0
_TOKENS_PER_WORD = 1.3  # ~0.75 words/token -> ~1.3 tokens/word; conservative (over-counts)


def estimate_tokens(text: str) -> int:
    """Estimate the token count of ``text`` (conservative; never under-counts prose).

    Returns the larger of a char-based and a word-based estimate so the chunker's budget
    is respected against the real tokenizer. Empty/whitespace text is 0 tokens.
    """
    stripped = text.strip()
    if not stripped:
        return 0
    char_estimate = len(stripped) / _CHARS_PER_TOKEN
    word_estimate = len(_WORD_RE.findall(stripped)) * _TOKENS_PER_WORD
    return max(1, round(max(char_estimate, word_estimate)))


def take_overlap_tail(text: str, overlap_tokens: int) -> str:
    """Return the trailing ~``overlap_tokens`` worth of ``text`` (whole words).

    Used to carry context across chunk boundaries (spec: 15% overlap). We walk words from
    the end until the estimated token budget is reached, so the overlap prefix is a clean
    suffix of the previous chunk rather than a mid-word cut.
    """
    if overlap_tokens <= 0:
        return ""
    words = _WORD_RE.findall(text)
    if not words:
        return ""
    tail: list[str] = []
    for word in reversed(words):
        tail.insert(0, word)
        if estimate_tokens(" ".join(tail)) >= overlap_tokens:
            break
    return " ".join(tail)
