"""Service configuration (pydantic-settings).

All secrets/config come from the environment (see repo `.env.example`). The
service is designed to run OFFLINE in dev: if ``ANTHROPIC_API_KEY`` /
``OPENAI_API_KEY`` are absent, the LLM and embedding steps fall back to
clearly-marked deterministic stubs so the full pipeline still executes.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-backed settings.

    Field names map to the env var names in repo `.env.example` (case-insensitive).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── Anthropic (primary LLM) ───────────────────────────────────────────────
    anthropic_api_key: str | None = None
    # Per spec: the Claude model id. Do not substitute.
    anthropic_model: str = "claude-sonnet-4-6"

    # ── OpenAI (embeddings only) ──────────────────────────────────────────────
    openai_api_key: str | None = None
    embedding_model: str = "text-embedding-3-large"
    # Fixed embedding dimensionality (Module 4 RAG). text-embedding-3-large supports the
    # OpenAI ``dimensions`` param; we FORCE one length so ingest-time and query-time
    # vectors are always identical (cosine similarity requires equal length). The offline
    # deterministic fallback emits a unit vector of exactly this dim too. Persisted on
    # EmbedResponse.dim and used by the document pipeline's chunk embeddings.
    embedding_dim: int = 1536

    # ── NVIDIA (OpenAI-compatible LLM) ────────────────────────────────────────
    # When NVIDIA_API_KEY is set, the LLM layer (app/llm.py) routes generation AND
    # native tool-use through NVIDIA's OpenAI-compatible endpoint instead of
    # Anthropic. The OpenAI SDK (already a dependency) is pointed at NVIDIA_BASE_URL.
    # Embeddings are unaffected (they keep their OpenAI / offline-fallback path).
    nvidia_api_key: str | None = None
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    # A tool-use (function-calling) capable model on NVIDIA's catalog.
    nvidia_model: str = "meta/llama-3.1-70b-instruct"

    # ── LangSmith (tracing + eval registry) ──────────────────────────────────
    langsmith_tracing: bool = False
    langsmith_api_key: str | None = None
    langsmith_project: str = "peopleos-dev"

    # ── LLM call tuning (spec Layer 4: async, timeout=30s, retry x3) ──────────
    llm_timeout_seconds: float = 30.0
    llm_max_retries: int = 3

    # ── Batch ranking (Module 1: "parallelised across applicant batch") ───────
    # Max number of candidates scored concurrently in score_batch. Bounds the fan-out
    # so a large applicant batch cannot exhaust connections / rate limits while still
    # holding the <8s/candidate latency target (spec Module 1 latency note).
    batch_concurrency: int = 8

    # ── Module 2 — Recruiter Copilot chat agent (2c) ──────────────────────────
    # The PeopleOS Node API base URL. The chat ReAct agent's tools call BACK to the
    # API's internal endpoints (``/internal/copilot/*``) because the AI service cannot
    # query the tenant database directly (it has no DB credentials by design).
    peopleos_api_url: str = "http://localhost:3001"
    # Shared service secret sent as the ``x-internal-secret`` header on those internal
    # calls so the API can authenticate the AI service (server-to-server). None offline.
    ai_service_secret: str | None = None
    # Bound on the recruiter-chat ReAct loop (spec Module 2c / Module 10: "Max
    # iterations: 8 — prevents infinite loops").
    chat_max_iterations: int = 8

    # ── Module 3 — Interview Intelligence (transcription) ─────────────────────
    # Self-hosted WhisperX model id (spec Module 3: "Whisper large-v3, self-hosted on
    # GPU — NOT OpenAI hosted Whisper"). Persisted as ``modelVersion`` on TranscribeResponse.
    whisper_model: str = "large-v3"
    # Master switch for the transcription adapter. Even when True, the adapter still
    # raises TranscriptionUnavailable (API -> 503) unless the GPU stack (whisperx + torch)
    # is importable AND the per-connector audio fetch is wired. Set False to hard-disable
    # transcription (e.g. dev/CI) so callers always use the "submit a transcript" path.
    transcription_enabled: bool = True

    @property
    def use_nvidia(self) -> bool:
        """Route LLM generation + tool-use through NVIDIA's OpenAI-compatible API."""
        return bool(self.nvidia_api_key)

    @property
    def anthropic_enabled(self) -> bool:
        """True when a real LLM call can be made (NVIDIA or Anthropic); else offline stub.

        Name kept for back-compat with the many call sites that gate on it; it now
        means "an LLM provider is configured", not Anthropic specifically.
        """
        return bool(self.anthropic_api_key or self.nvidia_api_key)

    @property
    def openai_enabled(self) -> bool:
        """True when real embeddings can be fetched; else use offline fallback."""
        return bool(self.openai_api_key)

    @property
    def model_version(self) -> str:
        """The model identifier persisted on every AI output (`modelVersion`)."""
        return self.nvidia_model if self.use_nvidia else self.anthropic_model


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()
