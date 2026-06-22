"""Module 3 — Interview Intelligence & Summaries (spec Layer 4).

Two AI surfaces, both camelCase end-to-end (mirroring @peopleos/schemas interview.ts):
  analyze     — the 4 spec analysis steps in one coherent pass (competency extraction,
                evidence-grounded scorecard, executive summary, calibration flags)
  transcribe  — self-hosted WhisperX large-v3 + diarisation adapter (NOT OpenAI hosted),
                degrading to a clear 503 when the GPU stack / audio is unavailable

PRIVACY (central): interview transcripts are highly sensitive. The analysis prompt
forbids repeating personal disclosures the candidate volunteers; transcription is
self-hosted so audio never leaves our infrastructure; every competency score is
evidence-grounded (no score without a verbatim transcript quote).
"""

from __future__ import annotations

from .analyze import analyze_interview
from .transcribe import TranscriptionUnavailable, transcribe_interview

__all__ = [
    "TranscriptionUnavailable",
    "analyze_interview",
    "transcribe_interview",
]
