"""Anthropic LLM wrapper.

Single entry point ``call_llm`` used by every prompt in the service:
    - async, timeout=30s (configurable), tenacity retry x3 with exponential backoff
      (spec Layer 4: "All LLM calls: async, timeout=30s, retry with exponential backoff x3")
    - attaches a LangSmith run name + tags per call (spec: "Specify the LangSmith
      trace name + tags for every LangGraph node")
    - returns the raw text of the first content block

Offline dev: when ``ANTHROPIC_API_KEY`` is absent the call raises
``LLMUnavailable``. Callers that must run offline (the JD-parse fallback, the
ranker's holistic node) catch this and use a clearly-marked deterministic stub.

Also exposes ``split_thinking`` which separates ``<thinking>...</thinking>`` (CoT,
stripped before returning to clients, stored for audit) from the final answer
(prompt standard #3).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import structlog
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from .config import Settings, get_settings

log = structlog.get_logger(__name__)

_THINKING_RE = re.compile(r"<thinking>(.*?)</thinking>", re.DOTALL | re.IGNORECASE)


class LLMUnavailable(RuntimeError):
    """Raised when no Anthropic API key is configured (offline dev)."""


class LLMCallError(RuntimeError):
    """Raised when the Anthropic call fails after all retries."""


@dataclass(slots=True)
class ThinkingSplit:
    """Result of separating chain-of-thought from the final answer."""

    thinking: str  # concatenated CoT — store for audit, NEVER return to client
    answer: str  # everything outside <thinking> tags


def split_thinking(text: str) -> ThinkingSplit:
    """Extract and strip ``<thinking>...</thinking>`` blocks (prompt standard #3).

    The concatenated thinking content is returned for audit storage; the answer is
    the remainder with thinking blocks removed and surrounding whitespace trimmed.
    """
    thoughts = [m.group(1).strip() for m in _THINKING_RE.finditer(text)]
    answer = _THINKING_RE.sub("", text).strip()
    return ThinkingSplit(thinking="\n\n".join(t for t in thoughts if t), answer=answer)


@dataclass(slots=True)
class LLMRequest:
    """A single Anthropic message request."""

    system: str
    user: str
    max_tokens: int = 2048
    temperature: float = 0.0
    run_name: str = "anthropic.call"
    tags: list[str] = field(default_factory=list)


def _build_client(settings: Settings) -> tuple[object, bool]:
    """Build the Anthropic client; return ``(client, traced)``.

    Imported lazily so the module imports without the SDK installed (offline dev).
    When LangSmith tracing is enabled we wrap the client with ``wrap_anthropic`` so
    calls are traced AND the wrapper consumes the ``langsmith_extra`` kwarg (run name
    + tags), stripping it before the request reaches the Anthropic API. The raw
    (unwrapped) client must NEVER receive ``langsmith_extra`` — the SDK would forward
    the unknown field into the request body and the API would reject it (HTTP 400).
    """
    from anthropic import AsyncAnthropic

    client: object = AsyncAnthropic(
        api_key=settings.anthropic_api_key,
        timeout=settings.llm_timeout_seconds,
    )
    if settings.langsmith_tracing:
        try:
            from langsmith.wrappers import wrap_anthropic

            return wrap_anthropic(client), True
        except Exception as exc:
            log.warning("langsmith_wrap_unavailable", error=str(exc))
    return client, False


# ── NVIDIA (OpenAI-compatible) backend ───────────────────────────────────────
# When ``settings.use_nvidia`` is true, generation + native tool-use are routed
# through NVIDIA's OpenAI-compatible Chat Completions endpoint using the OpenAI SDK
# (already a dependency). The recruiter/assistant ReAct loops build their history in
# ANTHROPIC shape (tool_use / tool_result content blocks); we translate that history
# and the tool schemas to OpenAI shape per call, then translate the response back into
# the same ``LLMToolTurn`` the Anthropic path returns — so no caller changes are needed.


def _build_openai_client(settings: Settings) -> object:
    """Async OpenAI client pointed at NVIDIA's OpenAI-compatible base URL."""
    from openai import AsyncOpenAI

    return AsyncOpenAI(
        api_key=settings.nvidia_api_key,
        base_url=settings.nvidia_base_url,
        timeout=settings.llm_timeout_seconds,
    )


def _openai_retryable() -> tuple[type[Exception], ...]:
    """Transient OpenAI-SDK errors worth retrying (4xx bad-request/auth fail fast)."""
    import openai

    return (
        openai.APIConnectionError,
        openai.APITimeoutError,
        openai.RateLimitError,
        openai.InternalServerError,
        LLMCallError,
    )


def _anthropic_tools_to_openai(tools: list[dict[str, object]]) -> list[dict[str, object]]:
    """Anthropic tool schema ({name, description, input_schema}) -> OpenAI function tool."""
    return [
        {
            "type": "function",
            "function": {
                "name": t.get("name"),
                "description": t.get("description", ""),
                "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
            },
        }
        for t in tools
    ]


def _anthropic_messages_to_openai(
    system: str, messages: list[dict[str, object]]
) -> list[dict[str, object]]:
    """Translate the ReAct loop's Anthropic-shape history into OpenAI chat messages.

    Handles plain string turns; assistant turns whose content is a list of
    text / tool_use blocks (-> an assistant message with ``tool_calls``); and user
    turns whose content is a list of tool_result blocks (-> one OpenAI ``tool`` message
    per result, keyed by ``tool_call_id``).
    """
    import json

    out: list[dict[str, object]] = [{"role": "system", "content": system}]
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue
        if role == "assistant":
            text_parts: list[str] = []
            tool_calls: list[dict[str, object]] = []
            for b in content or []:
                if b.get("type") == "text":
                    text_parts.append(b.get("text", ""))
                elif b.get("type") == "tool_use":
                    tool_calls.append(
                        {
                            "id": b.get("id"),
                            "type": "function",
                            "function": {
                                "name": b.get("name"),
                                "arguments": json.dumps(b.get("input", {})),
                            },
                        }
                    )
            msg: dict[str, object] = {"role": "assistant", "content": "".join(text_parts)}
            if tool_calls:
                msg["tool_calls"] = tool_calls
            out.append(msg)
        else:  # user turn carrying tool_result blocks
            for b in content or []:
                if b.get("type") == "tool_result":
                    out.append(
                        {
                            "role": "tool",
                            "tool_call_id": b.get("tool_use_id"),
                            "content": str(b.get("content", "")),
                        }
                    )
                else:
                    out.append({"role": "user", "content": str(b)})
    return out


async def _call_llm_nvidia(req: LLMRequest, settings: Settings) -> str:
    """Single-shot generation via NVIDIA's OpenAI-compatible Chat Completions."""
    client = _build_openai_client(settings)

    @retry(
        reraise=True,
        stop=stop_after_attempt(settings.llm_max_retries),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(_openai_retryable()),
    )
    async def _attempt() -> str:
        resp = await client.chat.completions.create(  # type: ignore[attr-defined]
            model=settings.nvidia_model,
            max_tokens=req.max_tokens,
            temperature=req.temperature,
            messages=[
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
        )
        text = (resp.choices[0].message.content or "").strip()
        if not text:
            raise LLMCallError("Empty response from NVIDIA")
        return text

    try:
        return await _attempt()
    except Exception as exc:
        log.error("nvidia_llm_failed", run_name=req.run_name, error=str(exc))
        raise LLMCallError(f"NVIDIA call failed after retries: {exc}") from exc


async def _call_llm_tools_nvidia(
    *,
    system: str,
    messages: list[dict[str, object]],
    tools: list[dict[str, object]],
    max_tokens: int,
    temperature: float,
    run_name: str,
    settings: Settings,
) -> "LLMToolTurn":
    """One native tool-use step via NVIDIA's OpenAI-compatible endpoint.

    Translates the Anthropic-shape history + tools to OpenAI shape, calls the model,
    and translates the response back into an ``LLMToolTurn`` (with Anthropic-shape
    ``raw_content``) so the caller's ReAct loop is unchanged.
    """
    import json

    client = _build_openai_client(settings)
    oai_messages = _anthropic_messages_to_openai(system, messages)
    oai_tools = _anthropic_tools_to_openai(tools)

    @retry(
        reraise=True,
        stop=stop_after_attempt(settings.llm_max_retries),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(_openai_retryable()),
    )
    async def _attempt() -> "LLMToolTurn":
        resp = await client.chat.completions.create(  # type: ignore[attr-defined]
            model=settings.nvidia_model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=oai_messages,
            tools=oai_tools,
            tool_choice="auto",
        )
        msg = resp.choices[0].message
        text = (msg.content or "").strip()
        raw_content: list[dict[str, object]] = []
        if text:
            raw_content.append({"type": "text", "text": text})
        tool_uses: list[ToolUseBlock] = []
        for tc in getattr(msg, "tool_calls", None) or []:
            try:
                args = json.loads(tc.function.arguments or "{}")
            except (ValueError, TypeError):
                args = {}
            tu = ToolUseBlock(id=tc.id, name=tc.function.name, input=dict(args))
            tool_uses.append(tu)
            raw_content.append(
                {"type": "tool_use", "id": tu.id, "name": tu.name, "input": tu.input}
            )
        return LLMToolTurn(
            stop_reason="tool_use" if tool_uses else "end_turn",
            text=text,
            tool_uses=tool_uses,
            raw_content=raw_content,
        )

    try:
        return await _attempt()
    except Exception as exc:
        log.error("nvidia_tool_call_failed", run_name=run_name, error=str(exc))
        raise LLMCallError(f"NVIDIA tool call failed after retries: {exc}") from exc


async def call_llm(req: LLMRequest, settings: Settings | None = None) -> str:
    """Call Claude with retry + LangSmith tracing; return the response text.

    Raises ``LLMUnavailable`` when offline (no API key) and ``LLMCallError`` when
    the call fails after exhausting retries.
    """
    settings = settings or get_settings()
    if not settings.anthropic_enabled:
        raise LLMUnavailable(
            "No LLM provider configured (NVIDIA_API_KEY / ANTHROPIC_API_KEY) — "
            "caller should use the offline fallback."
        )

    # NVIDIA (OpenAI-compatible) takes precedence when its key is set.
    if settings.use_nvidia:
        return await _call_llm_nvidia(req, settings)

    # Safe here: only reached when a key is set, so the SDK is installed.
    import anthropic

    client, traced = _build_client(settings)

    # Retry ONLY transient failures. Non-retryable 4xx (bad request, auth, unknown
    # model id) must fail fast instead of burning the 30s budget on pointless backoff.
    retryable = (
        anthropic.APIConnectionError,
        anthropic.APITimeoutError,
        anthropic.RateLimitError,
        anthropic.InternalServerError,
        LLMCallError,
    )

    @retry(
        reraise=True,
        stop=stop_after_attempt(settings.llm_max_retries),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(retryable),
    )
    async def _attempt() -> str:
        create_kwargs: dict[str, object] = {
            "model": settings.anthropic_model,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "system": req.system,
            "messages": [{"role": "user", "content": req.user}],
        }
        if traced:
            # Consumed by wrap_anthropic (NOT forwarded to the API): sets the
            # LangSmith run name + tags for this node (spec: trace name + tags per node).
            create_kwargs["langsmith_extra"] = {
                "name": req.run_name,
                "tags": ["peopleos", "ai-engine", *req.tags],
            }
        message = await client.messages.create(**create_kwargs)  # type: ignore[attr-defined]
        blocks = getattr(message, "content", [])
        parts = [getattr(b, "text", "") for b in blocks if getattr(b, "type", "") == "text"]
        text = "".join(parts).strip()
        if not text:
            raise LLMCallError("Empty response from Anthropic")
        return text

    try:
        return await _attempt()
    except LLMUnavailable:
        raise
    except Exception as exc:
        log.error("llm_call_failed", run_name=req.run_name, error=str(exc))
        raise LLMCallError(f"Anthropic call failed after retries: {exc}") from exc


@dataclass(slots=True)
class ToolUseBlock:
    """A single tool_use block the model emitted (native Anthropic tool-use)."""

    id: str  # tool_use id — must be echoed back in the matching tool_result
    name: str
    input: dict[str, object]


@dataclass(slots=True)
class LLMToolTurn:
    """One assistant turn in a tool-use conversation.

    ``stop_reason`` is "tool_use" when the model wants tools run, else "end_turn".
    ``text`` is the assistant's natural-language text (if any). ``tool_uses`` lists the
    tool calls to execute. ``raw_content`` is the assistant message's content blocks
    exactly as returned, so the caller can append them verbatim to the running
    ``messages`` list before adding tool_result blocks (the SDK requires the original
    assistant turn to precede its tool_result user turn).
    """

    stop_reason: str
    text: str
    tool_uses: list[ToolUseBlock]
    raw_content: list[dict[str, object]]


async def call_llm_tools(
    *,
    system: str,
    messages: list[dict[str, object]],
    tools: list[dict[str, object]],
    max_tokens: int = 1536,
    temperature: float = 0.2,
    run_name: str = "anthropic.tool_call",
    tags: list[str] | None = None,
    settings: Settings | None = None,
) -> LLMToolTurn:
    """One step of a native Anthropic tool-use loop (spec Module 2c ReAct agent).

    Sends the running ``messages`` (which may include prior assistant tool_use turns
    and user tool_result turns) plus the ``tools`` definitions, and returns the
    assistant's next turn parsed into an ``LLMToolTurn``. The caller (chat_agent.py)
    runs any requested tools, appends the assistant turn + tool_result turn to
    ``messages``, and calls again — bounded to a max number of iterations.

    Raises ``LLMUnavailable`` offline (the ReAct loop needs the model to choose tools;
    the caller returns a clearly-marked stub answer) and ``LLMCallError`` on failure
    after retries. Same retry + LangSmith policy as ``call_llm``.
    """
    settings = settings or get_settings()
    if not settings.anthropic_enabled:
        raise LLMUnavailable(
            "No LLM provider configured — the ReAct loop requires the LLM to choose tools."
        )

    # NVIDIA (OpenAI-compatible) takes precedence when its key is set.
    if settings.use_nvidia:
        return await _call_llm_tools_nvidia(
            system=system,
            messages=messages,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
            run_name=run_name,
            settings=settings,
        )

    import anthropic

    client, traced = _build_client(settings)

    retryable = (
        anthropic.APIConnectionError,
        anthropic.APITimeoutError,
        anthropic.RateLimitError,
        anthropic.InternalServerError,
        LLMCallError,
    )

    @retry(
        reraise=True,
        stop=stop_after_attempt(settings.llm_max_retries),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(retryable),
    )
    async def _attempt() -> LLMToolTurn:
        create_kwargs: dict[str, object] = {
            "model": settings.anthropic_model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system,
            "messages": messages,
            "tools": tools,
        }
        if traced:
            create_kwargs["langsmith_extra"] = {
                "name": run_name,
                "tags": ["peopleos", "ai-engine", *(tags or [])],
            }
        message = await client.messages.create(**create_kwargs)  # type: ignore[attr-defined]
        blocks = getattr(message, "content", [])
        text_parts: list[str] = []
        tool_uses: list[ToolUseBlock] = []
        raw_content: list[dict[str, object]] = []
        for b in blocks:
            btype = getattr(b, "type", "")
            if btype == "text":
                text = getattr(b, "text", "")
                text_parts.append(text)
                raw_content.append({"type": "text", "text": text})
            elif btype == "tool_use":
                tu = ToolUseBlock(
                    id=getattr(b, "id", ""),
                    name=getattr(b, "name", ""),
                    input=dict(getattr(b, "input", {}) or {}),
                )
                tool_uses.append(tu)
                raw_content.append(
                    {"type": "tool_use", "id": tu.id, "name": tu.name, "input": tu.input}
                )
        return LLMToolTurn(
            stop_reason=getattr(message, "stop_reason", "end_turn") or "end_turn",
            text="".join(text_parts).strip(),
            tool_uses=tool_uses,
            raw_content=raw_content,
        )

    try:
        return await _attempt()
    except LLMUnavailable:
        raise
    except Exception as exc:
        log.error("llm_tool_call_failed", run_name=run_name, error=str(exc))
        raise LLMCallError(f"Anthropic tool call failed after retries: {exc}") from exc
