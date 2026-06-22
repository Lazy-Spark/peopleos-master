"""Module 10 — Agentic HR Assistant ReAct loop (the capstone).

``run_assistant(req) -> AssistantChatAiResponse`` runs a bounded reason -> act -> observe
loop (mirrors app/copilot/chat_agent.py) over the ROLE-FILTERED tool registry:

  1. Build the role-aware system prompt + ``tools_for_role(req.context.role)`` so the model
     only ever SEES the tools its role may use.
  2. Assemble messages from history + the new message; loop ``call_llm_tools`` (CAPPED at
     ``settings.chat_max_iterations``, default 8 — spec: "Max iterations: 8").
  3. On stop_reason == "tool_use": dispatch EACH requested tool with ``req.context`` attached
     PROGRAMMATICALLY (never from model output), append the tool_result, and accumulate a
     ToolCallTrace { tool, ok, summary } per call (summary from ToolInvokeResponse.summary —
     NEVER raw sensitive output). Then loop.
  4. On stop_reason == "end_turn": the assistant text (with <thinking> stripped) is the reply.

Offline / LLM-unavailable (no ANTHROPIC_API_KEY): a graceful, CLEARLY-MARKED, tool-free
reply — never crash. A single tool error degrades to ok:false and the loop keeps going.
"""

from __future__ import annotations

import json

import structlog

from ..config import Settings, get_settings
from ..llm import (
    LLMCallError,
    LLMUnavailable,
    call_llm_tools,
    split_thinking,
)
from ..prompts.assistant import build_assistant_system_prompt
from ..schemas import (
    AssistantChatAiRequest,
    AssistantChatAiResponse,
    ToolCallTrace,
)
from .suggestions import suggested_actions_for_role
from .tools import (
    ToolResult,
    anthropic_tools_for_role,
    dispatch,
    write_tool_names,
)

log = structlog.get_logger(__name__)


def _org_name(req: AssistantChatAiRequest) -> str | None:
    """Best-effort org name from orgContext for the prompt greeting (no other tenant data)."""
    if req.orgContext is None:
        return None
    return req.orgContext.orgName


def _initial_messages(req: AssistantChatAiRequest) -> list[dict[str, object]]:
    """History turns + the new user message, as Anthropic message dicts."""
    messages: list[dict[str, object]] = [
        {"role": turn.role, "content": turn.content} for turn in req.history
    ]
    messages.append({"role": "user", "content": req.message})
    return messages


def _offline_reply(req: AssistantChatAiRequest) -> AssistantChatAiResponse:
    """Clearly-marked, tool-free fallback when the LLM is unavailable.

    The ReAct loop needs the model to plan its tool use, so with no ANTHROPIC_API_KEY we
    cannot run the live agent. We return a graceful, honest message (never a fabricated
    answer) plus role-aware suggested actions so the UI still guides the user.
    """
    reply = (
        "[OFFLINE] The PeopleOS Assistant needs the language model to plan which tools to "
        "use, and no language model is configured in this environment, so I can't run the "
        "live assistant right now. Once it's enabled I can act on your request using the HR "
        "tools available to your role. You asked: "
        f'"{req.message[:200]}".'
    )
    return AssistantChatAiResponse(
        reply=reply,
        toolCalls=[],
        suggestedActions=suggested_actions_for_role(req.context.role),
    )


def _error_reply(req: AssistantChatAiRequest, trace: list[ToolCallTrace]) -> AssistantChatAiResponse:
    """Graceful reply when the model call errors out after retries (loop did not crash)."""
    return AssistantChatAiResponse(
        reply=(
            "I hit an error talking to the language model and couldn't finish your request. "
            "Please try again in a moment."
        ),
        toolCalls=trace,
        suggestedActions=suggested_actions_for_role(req.context.role),
    )


def _observation_content(result: ToolResult) -> str:
    """The observation fed back to the model: the short summary (+ optional <data> block).

    The structured ``data`` lets the model answer precisely; it is wrapped in a <data> tag the
    system prompt marks as WORKING CONTEXT ONLY. The TRACE never carries this — only the short,
    non-sensitive summary (spec: never raw sensitive output in the trace).
    """
    if result.data is None:
        return result.summary
    return f"{result.summary}\n\n<data>{json.dumps(result.data)}</data>"


async def run_assistant(
    req: AssistantChatAiRequest,
    *,
    settings: Settings | None = None,
) -> AssistantChatAiResponse:
    """Run the bounded, role-aware Agentic HR Assistant ReAct loop (spec Module 10)."""
    settings = settings or get_settings()

    system = build_assistant_system_prompt(req.context.role, org_name=_org_name(req))
    messages = _initial_messages(req)
    tools = anthropic_tools_for_role(req.context.role)
    trace: list[ToolCallTrace] = []
    max_iters = max(1, settings.chat_max_iterations)
    write_names = write_tool_names()

    final_reply = ""
    for iteration in range(max_iters):
        is_last_iteration = iteration == max_iters - 1
        try:
            turn = await call_llm_tools(
                system=system,
                messages=messages,
                tools=tools,
                max_tokens=1536,
                temperature=0.2,
                run_name="module10.assistant",
                tags=["module10", "assistant", req.context.role, f"iter{iteration}"],
                settings=settings,
            )
        except LLMUnavailable:
            return _offline_reply(req)
        except LLMCallError as exc:
            log.error("assistant_llm_failed", error=str(exc))
            return _error_reply(req, trace)

        # Treat the turn as a tool step whenever it carries tool_use blocks — INCLUDING a
        # turn truncated at the token cap (stop_reason == "max_tokens"), whose complete
        # tool_use blocks Anthropic still returns. Dropping them here would silently
        # discard the model's requested tools. Only a turn with NO tool_uses (or some other
        # stop reason) is the final answer.
        if not turn.tool_uses or turn.stop_reason not in ("tool_use", "max_tokens"):
            # Strip <thinking> CoT from the CLIENT-FACING reply (standard #3). Any reasoning the
            # model emits on intermediate tool_use turns stays in the model's working context
            # only — it is echoed back to the model for the tool protocol, never returned to the
            # client or recorded in the (summary-only) trace.
            final_reply = split_thinking(turn.text).answer or "I don't have anything to add."
            break

        # Append the assistant's tool_use turn verbatim (required before tool_result).
        messages.append({"role": "assistant", "content": turn.raw_content})

        # Run EACH requested tool with the TRUSTED context attached programmatically.
        tool_result_blocks: list[dict[str, object]] = []
        for tu in turn.tool_uses:
            # On the FINAL allowed iteration we will not loop again, so the model can never
            # observe or confirm a tool result. Do NOT fire an audited WRITE/action tool here
            # — its effect would be performed but discarded. Defer it instead.
            if is_last_iteration and tu.name in write_names:
                trace.append(
                    ToolCallTrace(
                        tool=tu.name,
                        ok=False,
                        summary="Deferred: not run on the final step (step limit reached).",
                    )
                )
                tool_result_blocks.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": "Not executed — reached the step limit. Ask again to confirm this action.",
                        "is_error": True,
                    }
                )
                continue
            result = await dispatch(tu.name, tu.input, req.context, settings=settings)
            # Trace carries ONLY the short, non-sensitive summary (no raw output).
            trace.append(ToolCallTrace(tool=tu.name, ok=result.ok, summary=result.summary))
            tool_result_blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": _observation_content(result),
                    "is_error": not result.ok,
                }
            )
        messages.append({"role": "user", "content": tool_result_blocks})
    else:
        # Loop exhausted without a final answer (hit the iteration cap) — never loop forever.
        log.info("assistant_iteration_cap", maxIters=max_iters)
        final_reply = (
            "I worked through several steps but reached my step limit before finishing. Here is "
            "what I gathered so far; please narrow the request and I'll continue."
        )

    return AssistantChatAiResponse(
        reply=final_reply,
        toolCalls=trace,
        suggestedActions=suggested_actions_for_role(req.context.role),
    )
