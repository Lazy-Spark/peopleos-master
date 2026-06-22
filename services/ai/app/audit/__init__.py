"""Bias / disparity audit for Module 1 (spec step 6 + the ethics checklist).

Pure-statistics, NO LLM: given scored candidates tagged with a per-request,
org-supplied demographic group label, compute selection-rate parity (the EEOC
"4/5ths rule") and score distribution. PeopleOS deliberately does not store
protected attributes — the mapping is provided per request only where legitimate
EEOC self-id data exists (see packages/schemas/src/audit.ts).
"""

from __future__ import annotations

from .disparity import compute_disparity

__all__ = ["compute_disparity"]
