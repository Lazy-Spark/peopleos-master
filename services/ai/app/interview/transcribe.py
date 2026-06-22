"""Module 3 — Transcription adapter (self-hosted WhisperX large-v3 + diarisation).

Takes a ``TranscribeRequest`` (an ``audioUrl`` + the recording ``source``) and returns a
``TranscribeResponse`` carrying a diarised ``InterviewTranscript``.

WHY SELF-HOSTED (NOT OpenAI hosted Whisper): interview content is highly sensitive and
must not leave our infrastructure. Per the spec (Module 3) and the master prompt's
privacy section, transcription runs on a self-hosted GPU using WhisperX large-v3 with
speaker diarisation — we NEVER send interview audio to OpenAI's hosted Whisper API.

ENVIRONMENT REALITY: the GPU stack (whisperx + torch + pyannote) and the actual audio
are not available in this dev/CI environment. The adapter therefore guards the heavy
imports and, when the stack or audio is unavailable, raises ``TranscriptionUnavailable``
— which the API maps to HTTP 503 so the recommended dev path becomes "submit a
transcript" (``SubmitTranscriptRequest``) instead of transcribing. We deliberately do
NOT fabricate a transcript: a hallucinated interview transcript would be worse than none.

PER-CONNECTOR AUDIO FETCH (TODO — out of scope for this service): obtaining the audio
bytes from each recording source requires connector-specific, authenticated downloads
that belong in the Node API / a worker, not here:
  - ZOOM        — Cloud Recording completed webhook -> GET the recording download_url
                  with an OAuth (S2S) token; audio_only (M4A) file.
  - GOOGLE_MEET — recording lands in Drive -> Drive API files.get(alt=media) with the
                  meeting organiser's delegated credentials.
  - MS_TEAMS    — Graph callRecords / onlineMeetings recording -> Graph
                  /communications content download with application permissions.
  - UPLOAD      — recruiter-uploaded MP3/MP4 already in our S3 (SSE-KMS) bucket.
In every case the bytes must be streamed to a temp file on the GPU host, transcribed,
and the resulting transcript stored ENCRYPTED (S3 AES-256 SSE-KMS); the audio is then
deleted per retention policy. None of that is implemented here — this module is only the
WhisperX inference adapter behind a guarded import.
"""

from __future__ import annotations

import importlib.util

import structlog

from ..config import Settings, get_settings
from ..schemas import TranscribeRequest, TranscribeResponse

log = structlog.get_logger(__name__)


class TranscriptionUnavailable(RuntimeError):
    """Raised when self-hosted transcription cannot run in this environment.

    The API maps this to HTTP 503 (Service Unavailable) with a Retry/After-style hint so
    the caller falls back to the "submit a transcript" path (SubmitTranscriptRequest).
    Carries a machine-readable ``reason`` for the API to surface.
    """

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def _whisperx_available() -> bool:
    """True only when the self-hosted GPU stack is importable.

    Checked without importing (no side effects, no torch CUDA init) so the module loads
    cleanly in this environment. We require BOTH whisperx and torch.
    """
    return (
        importlib.util.find_spec("whisperx") is not None
        and importlib.util.find_spec("torch") is not None
    )


async def transcribe_interview(
    req: TranscribeRequest,
    *,
    settings: Settings | None = None,
) -> TranscribeResponse:
    """Transcribe + diarise an interview recording (spec Module 3 transcription pipeline).

    Flow when fully provisioned (production, GPU host):
      1. fetch audio bytes for ``req.audioUrl`` (connector-specific — see module docstring)
      2. WhisperX large-v3 transcription (word-level timestamps)
      3. WhisperX forced alignment + pyannote speaker diarisation (interviewer/candidate)
      4. map diarised segments -> ``TranscriptSegment`` (speakerLabel/role/start/end/text)
      5. assemble ``InterviewTranscript`` (diarised=True, durationSec, language)

    In THIS environment the GPU stack / audio are unavailable, so we raise
    ``TranscriptionUnavailable`` (API -> 503). We never fabricate a transcript.
    """
    settings = settings or get_settings()

    if not settings.transcription_enabled:
        raise TranscriptionUnavailable(
            "Self-hosted transcription is disabled (transcription_enabled=False). "
            "Submit a transcript via SubmitTranscriptRequest instead."
        )

    if not _whisperx_available():
        log.info(
            "transcription_stack_unavailable",
            orgId=req.orgId,
            interviewId=req.interviewId,
            source=req.source,
            model=settings.whisper_model,
        )
        raise TranscriptionUnavailable(
            "Self-hosted WhisperX + GPU stack is not available in this environment "
            f"(whisper_model={settings.whisper_model}). In production this runs on a GPU "
            "host. For now, submit a transcript via SubmitTranscriptRequest."
        )

    # ── Production path (GPU host only) ───────────────────────────────────────
    # Reached only when whisperx + torch are importable AND transcription is enabled.
    # The heavy imports + connector audio fetch live behind this guard so the module
    # imports cleanly offline. The body is intentionally a guarded stub: wiring the real
    # WhisperX inference + per-connector audio fetch is the production task (see TODOs in
    # the module docstring). Until then we still degrade cleanly rather than fabricate.
    raise TranscriptionUnavailable(
        "WhisperX is importable but the GPU inference + per-connector audio fetch are not "
        "wired in this build (production TODO). Submit a transcript via "
        "SubmitTranscriptRequest, or run the dedicated GPU transcription worker."
    )

    # NOTE for the production implementer (kept as a reference for the real wiring):
    #   import whisperx
    #   device = "cuda"
    #   audio_path = await _fetch_audio(req.audioUrl, req.source, settings)  # connector
    #   model = whisperx.load_model(settings.whisper_model, device, compute_type="float16")
    #   result = model.transcribe(whisperx.load_audio(audio_path), language=req.language)
    #   align_model, meta = whisperx.load_align_model(result["language"], device)
    #   aligned = whisperx.align(result["segments"], align_model, meta, audio_path, device)
    #   diarize = whisperx.DiarizationPipeline(use_auth_token=settings.hf_token, device=device)
    #   diarised = whisperx.assign_word_speakers(diarize(audio_path), aligned)
    #   segments = [_to_segment(s) for s in diarised["segments"]]  # map speaker -> role
    #   transcript = InterviewTranscript(segments=segments, diarised=True,
    #                                    durationSec=..., language=result["language"],
    #                                    source=req.source)
    #   # store transcript ENCRYPTED in S3 (SSE-KMS); delete the audio per retention.
    #   return TranscribeResponse(transcript=transcript, modelVersion=settings.whisper_model)


__all__ = ["TranscriptionUnavailable", "transcribe_interview"]
