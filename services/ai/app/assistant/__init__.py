"""Module 10 — Agentic HR Assistant (spec Layer 4, the capstone).

An org-wide, ROLE-AWARE ReAct agent that orchestrates every prior module's
capability as a tool. The loop runs here (in the AI service); each tool call
dispatches to the Node API's secret-authed ``/internal/assistant/tool`` endpoint,
which RE-ENFORCES tenancy + per-tool role governance from the TRUSTED session
context — never from the agent's tool arguments. The agent therefore can never
become a confused deputy.

This package generalises the Module 2c recruiter chat (``app/copilot/``) to a
role-filtered, multi-module tool registry:

  tools.py   — the tool REGISTRY (name + description + input_schema + allowed_roles),
               ``tools_for_role(role)`` (the role filter — the model only SEES its
               permitted tools), and ``dispatch(tool, args, context)`` (POSTs the
               ToolInvokeRequest with the x-internal-secret header; context is attached
               PROGRAMMATICALLY from the turn, NEVER from model output).
  agent.py   — ``run_assistant(req)`` — the bounded ReAct loop (mirrors chat_agent.py).

The system prompt lives in ``app/prompts/assistant.py``.
"""

from __future__ import annotations
