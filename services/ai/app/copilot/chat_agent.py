"""Module 2c — Recruiter Chat Assistant (bounded ReAct agent).

A reason -> act -> observe loop using the Anthropic SDK's NATIVE tool-use (the
``tools`` param + tool_use / tool_result content blocks), capped at
``settings.chat_max_iterations`` (default 8 — spec: "Max iterations: 8, prevents
infinite loops"). We deliberately do NOT use langchain-anthropic; the loop is driven
directly through the existing anthropic client (extended in app/llm.py).

Flow per turn:
  1. Send the conversation + tool schemas to the model (``call_llm_tools``).
  2. If stop_reason == "tool_use": run each requested tool with org/job context
     injected from the REQUEST (never the model — tenant isolation), append the
     assistant tool_use turn + a user tool_result turn, and loop.
  3. Else: the assistant's text is the final answer.

Returns ``RecruiterChatResponse`` { answer, toolTrace (tool + ok + short
resultSummary; NO raw data dumps), modelVersion }.

OFFLINE (no ANTHROPIC_API_KEY): the loop cannot run (it needs the model to choose
tools), so we return a clearly-marked stub answer. Tests stub the LLM + httpx.
"""

from __future__ import annotations

import structlog

from ..config import Settings, get_settings
from ..llm import LLMCallError, LLMUnavailable, call_llm_tools
from ..schemas import (
    ChatToolInvocation,
    RecruiterChatRequest,
    RecruiterChatResponse,
)
from .tools import ToolResult, dispatch_tool, tool_schemas

log = structlog.get_logger(__name__)

_SYSTEM_PROMPT_HEADER = """<system>
  <role>Recruiter Copilot — an AI assistant embedded in the PeopleOS recruiter
    workspace for an AI-native HR platform.</role>
  <context>
    - You help a recruiter manage their pipeline: finding candidates, reading pipeline
      stats, summarising candidates, and drafting outreach.
    - You have tools that read the organisation's data. The data is tenant-scoped for
      you automatically — you never specify which organisation; just call the tools.
  </context>
  <task_definition>
    Answer the recruiter's request. Use tools to gather facts before answering — do
    NOT guess candidate names, counts, or pipeline numbers. Take at most a few tool
    steps, then give a concise, direct answer grounded in what the tools returned.
  </task_definition>
  <constraints>
    - Hallucination prevention: only state facts that came from a tool result or the
      conversation. If a tool fails or returns nothing, say so plainly.
    - Advisory only: never claim to have taken an irreversible action (e.g. sending an
      email or booking a meeting) unless a tool confirmed it. draft_email only DRAFTS.
    - schedule_interview is not yet available (Phase 2); if asked, explain that and
      offer to draft an email or summarise the candidate instead.
    - Be inclusive and professional. Do not reference protected attributes.
    - Keep the final answer concise; do not dump raw tool data.
    - Any <data> block in a tool observation is WORKING CONTEXT ONLY: use it to reason
      and to state specific, relevant facts, but never paste it back verbatim into your
      answer (no full profiles, no bulk records).
  </constraints>
</system>"""


def _system_prompt(req: RecruiterChatRequest) -> str:
    """Assemble the system prompt, noting the reviewing user's role + active pipeline."""
    extras: list[str] = []
    if req.userRole:
        extras.append(f"The requesting user's role is {req.userRole}; pitch your answer accordingly.")
    if req.jobId:
        extras.append(
            "The recruiter is currently viewing a specific job (active pipeline context); "
            "tools may use it by default when you omit a jobId."
        )
    if not extras:
        return _SYSTEM_PROMPT_HEADER
    note = "\n".join(f"  {e}" for e in extras)
    return f"{_SYSTEM_PROMPT_HEADER}\n<session_context>\n{note}\n</session_context>"


def _initial_messages(req: RecruiterChatRequest) -> list[dict[str, object]]:
    """Map the request's ChatTurns into Anthropic message dicts."""
    return [{"role": turn.role, "content": turn.content} for turn in req.messages]


def _offline_stub_answer(req: RecruiterChatRequest) -> RecruiterChatResponse:
    """Clearly-marked offline stub: the ReAct loop needs the LLM to choose tools."""
    last_user = next((m.content for m in reversed(req.messages) if m.role == "user"), "")
    answer = (
        "[OFFLINE STUB] The recruiter chat assistant needs the language model to plan "
        "its tool use, and no ANTHROPIC_API_KEY is configured in this environment, so I "
        "cannot run the live agent. Your message was: "
        f"\"{last_user[:200]}\". With the model enabled I would search candidates, read "
        "pipeline stats, summarise candidates, or draft outreach to answer this."
    )
    return RecruiterChatResponse(answer=answer, toolTrace=[], modelVersion="offline_stub")


async def run_recruiter_chat(
    req: RecruiterChatRequest,
    *,
    settings: Settings | None = None,
) -> RecruiterChatResponse:
    """Run the bounded recruiter-chat ReAct agent (spec 2c)."""
    settings = settings or get_settings()

    system = _system_prompt(req)
    messages = _initial_messages(req)
    tools = tool_schemas(req.jobId)
    trace: list[ChatToolInvocation] = []
    max_iters = max(1, settings.chat_max_iterations)

    final_answer = ""
    for iteration in range(max_iters):
        try:
            turn = await call_llm_tools(
                system=system,
                messages=messages,
                tools=tools,
                max_tokens=1536,
                temperature=0.2,
                run_name="module2.recruiter_chat",
                tags=["module2", "chat", f"iter{iteration}"],
                settings=settings,
            )
        except LLMUnavailable:
            return _offline_stub_answer(req)
        except LLMCallError as exc:
            log.error("recruiter_chat_llm_failed", error=str(exc))
            return RecruiterChatResponse(
                answer=(
                    "I hit an error talking to the language model and could not complete "
                    "your request. Please try again."
                ),
                toolTrace=trace,
                modelVersion=settings.model_version,
            )

        # A turn carrying tool_use blocks is a tool step — including one truncated at the
        # token cap (stop_reason == "max_tokens"), whose complete tool_use blocks Anthropic
        # still returns; dropping them would silently discard the model's requested tools.
        if not turn.tool_uses or turn.stop_reason not in ("tool_use", "max_tokens"):
            final_answer = turn.text or "I do not have anything to add."
            break

        # Append the assistant's tool_use turn verbatim (required before tool_result).
        messages.append({"role": "assistant", "content": turn.raw_content})

        # Run each requested tool; org/job context comes from the REQUEST, not the model.
        tool_result_blocks: list[dict[str, object]] = []
        for tu in turn.tool_uses:
            result: ToolResult = await dispatch_tool(
                name=tu.name,
                tool_input=tu.input,
                org_id=req.orgId,
                default_job_id=req.jobId,
                settings=settings,
            )
            trace.append(
                ChatToolInvocation(tool=tu.name, ok=result.ok, resultSummary=result.summary)
            )
            # The observation fed back to the model: the short summary (+ optional data).
            content = result.summary
            if result.data is not None:
                # Feed structured data back so the model can answer precisely, but the
                # TRACE only ever carries the short summary (spec: no raw data dumps).
                import json

                content = f"{result.summary}\n\n<data>{json.dumps(result.data)}</data>"
            tool_result_blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": content,
                    "is_error": not result.ok,
                }
            )
        messages.append({"role": "user", "content": tool_result_blocks})
    else:
        # Loop exhausted without a final answer (hit the iteration cap).
        log.info("recruiter_chat_iteration_cap", maxIters=max_iters)
        final_answer = (
            "I gathered information across several steps but reached my step limit before "
            "finishing. Here is what I found so far; please narrow the request and I'll "
            "continue."
        )

    return RecruiterChatResponse(
        answer=final_answer,
        toolTrace=trace,
        modelVersion=settings.model_version,
    )
