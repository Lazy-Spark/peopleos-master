"""Unit tests for Module 10 — Agentic HR Assistant (the capstone).

The capstone is an org-wide, ROLE-AWARE ReAct agent whose security model is the whole point.
These tests pin the trust boundary, all WITHOUT network:

  - tools_for_role filters correctly: an EMPLOYEE never gets get_attrition_summary, and a
    RECRUITER never gets it either (it's HRBP/ADMIN-only); the visible set matches the FROZEN
    assistant.ts gate vocabulary.
  - context is NEVER sourced from the model / tool args: every tool's input_schema declares
    ONLY its own args (no orgId/userId/role), and dispatch attaches the trusted context
    programmatically + strips any identity keys a prompt-injected model smuggles into args.
  - a disallowed tool / a tool error degrades to ok:false WITHOUT crashing the loop.
  - the ReAct loop is CAPPED (it cannot spin forever).
  - the role allowlist is independently re-checked in dispatch (defence in depth).

The agent loop is exercised by stubbing ``call_llm_tools`` (no LLM) and httpx (no API),
mirroring the Module 2c test approach.
"""

from __future__ import annotations

import pytest
from app.assistant import agent as assistant_agent
from app.assistant.agent import run_assistant
from app.assistant.suggestions import suggested_actions_for_role
from app.assistant.tools import (
    _FORBIDDEN_ARG_KEYS,
    _is_identity_key,
    _sanitise_args,
    AssistantToolDef,
    all_tools,
    anthropic_tools_for_role,
    dispatch,
    tool_def,
    tools_for_role,
    write_tool_names,
)
from app.config import Settings
from app.schemas import AssistantChatAiRequest, AssistantContext

_ORG = "00000000-0000-0000-0000-000000000001"
_USER = "00000000-0000-0000-0000-000000000002"

# The FROZEN assistant.ts gate vocabulary (assistant.ts lines 17-23) — the expected visible
# tool set per role, used to pin tools_for_role.
_ALL_ROLE_TOOLS = {
    "answer_policy_question",
    "raise_hr_ticket",
    "get_my_skill_profile",
    "get_skill_gap",
    "recommended_roles",
    "list_my_tasks",
}
_RECRUITER_EXTRA = {"rank_candidates", "draft_jd", "generate_outreach", "find_internal_candidates"}
_MANAGER_EXTRA = {"get_employee_attrition", "get_team_skill_map"}
_PEOPLE_ADMIN_EXTRA = {
    "get_analytics_dashboard",
    "ask_workforce_data",
    "get_attrition_summary",
    "get_succession",
    "get_skill_inventory",
    "draft_workflow",
    "start_workflow",
}


def _offline_settings() -> Settings:
    """No Anthropic key (forces the offline fallback) and no internal API secret."""
    return Settings(anthropic_api_key=None, ai_service_secret=None)


def _configured_settings() -> Settings:
    """A service secret so dispatch attempts the internal call (httpx stubbed in tests)."""
    return Settings(
        anthropic_api_key=None,
        ai_service_secret="test-secret-123",
        peopleos_api_url="http://api.test:3001",
    )


def _ctx(role: str) -> AssistantContext:
    return AssistantContext(orgId=_ORG, userId=_USER, role=role)


def _names(role: str) -> set[str]:
    return {t.name for t in tools_for_role(role)}


# ═══ tools_for_role filters correctly ══════════════════════════════════════════
def test_employee_sees_only_self_service_tools() -> None:
    assert _names("EMPLOYEE") == _ALL_ROLE_TOOLS


def test_employee_never_gets_attrition_summary() -> None:
    # The headline guarantee: an EMPLOYEE cannot even SEE the HR-only attrition summary.
    assert "get_attrition_summary" not in _names("EMPLOYEE")
    # Nor any other people-admin / manager / recruiter tool.
    assert _names("EMPLOYEE").isdisjoint(_PEOPLE_ADMIN_EXTRA)
    assert _names("EMPLOYEE").isdisjoint(_MANAGER_EXTRA)
    assert _names("EMPLOYEE").isdisjoint(_RECRUITER_EXTRA)


def test_recruiter_never_gets_attrition_summary_either() -> None:
    # A RECRUITER has recruiting tools but NOT the HRBP/ADMIN attrition summary.
    recruiter = _names("RECRUITER")
    assert "get_attrition_summary" not in recruiter
    assert _RECRUITER_EXTRA.issubset(recruiter)
    # Recruiter has no manager/people-admin tools (no attrition, no analytics, no workflows).
    assert recruiter.isdisjoint(_PEOPLE_ADMIN_EXTRA)
    assert recruiter.isdisjoint(_MANAGER_EXTRA)


def test_manager_gets_own_report_attrition_but_not_the_summary() -> None:
    manager = _names("MANAGER")
    # Manager can read an own-report attrition tier, but NOT the org-wide aggregate summary.
    assert "get_employee_attrition" in manager
    assert "get_attrition_summary" not in manager
    assert _MANAGER_EXTRA.issubset(manager)
    # No recruiting or org-wide analytics tools.
    assert manager.isdisjoint(_RECRUITER_EXTRA)
    assert manager.isdisjoint(_PEOPLE_ADMIN_EXTRA)


def test_hrbp_and_admin_get_the_full_governed_set() -> None:
    for role in ("HRBP", "ADMIN"):
        names = _names(role)
        assert "get_attrition_summary" in names
        assert _PEOPLE_ADMIN_EXTRA.issubset(names)
        assert _RECRUITER_EXTRA.issubset(names)  # people roles also get recruiting tools
        assert _MANAGER_EXTRA.issubset(names)
        assert _ALL_ROLE_TOOLS.issubset(names)


def test_anthropic_tools_for_role_shape_matches_filter() -> None:
    schemas = anthropic_tools_for_role("RECRUITER")
    assert {s["name"] for s in schemas} == _names("RECRUITER")
    # Every Anthropic tool entry carries the required keys.
    for s in schemas:
        assert set(s.keys()) == {"name", "description", "input_schema"}


def test_registry_covers_exactly_the_frozen_vocabulary() -> None:
    frozen = _ALL_ROLE_TOOLS | _RECRUITER_EXTRA | _MANAGER_EXTRA | _PEOPLE_ADMIN_EXTRA
    assert {t.name for t in all_tools()} == frozen


# ═══ context is NEVER sourced from the model / tool args ════════════════════════
def test_no_tool_input_schema_contains_identity_fields() -> None:
    # The core anti-confused-deputy invariant: a tool's input_schema declares ONLY its own
    # args. orgId/userId/role must NEVER appear as a tool parameter.
    for t in all_tools():
        props = t.input_schema.get("properties", {})
        assert isinstance(props, dict)
        for forbidden in _FORBIDDEN_ARG_KEYS:
            assert forbidden not in props, f"{t.name} must not declare {forbidden} as an arg"


def test_input_schema_is_well_formed_object() -> None:
    for t in all_tools():
        assert t.input_schema["type"] == "object"
        assert isinstance(t.input_schema.get("properties", {}), dict)
        required = t.input_schema.get("required", [])
        assert isinstance(required, list)
        # Every required key is actually declared as a property.
        for key in required:
            assert key in t.input_schema["properties"]


def test_registry_rejects_identity_field_in_a_tool_schema() -> None:
    # Constructing a registry entry's schema with an identity field must be impossible.
    from app.assistant.tools import _obj_schema

    with pytest.raises(ValueError, match="identity"):
        _obj_schema({"orgId": {"type": "string"}})


@pytest.mark.asyncio
async def test_dispatch_attaches_trusted_context_and_strips_smuggled_identity(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A prompt-injected model puts orgId/userId/role in args; dispatch must drop them and
    attach the TRUSTED context from the request instead."""
    import httpx

    captured: dict[str, object] = {}

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"ok": True, "data": {"answer": "PTO is 25 days"}, "summary": "Answered policy q.", "error": None}

    class _FakeAsyncClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *_e: object) -> None:
            return None

        async def post(self, url: str, *, json: dict[str, object], headers: dict[str, str]):  # type: ignore[no-untyped-def]
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return _FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    ctx = _ctx("EMPLOYEE")
    # The model tries to smuggle a DIFFERENT org/user/role into the args.
    result = await dispatch(
        "answer_policy_question",
        {
            "question": "How much PTO do I get?",
            "orgId": "EVIL-ORG",
            "userId": "EVIL-USER",
            "role": "ADMIN",
        },
        ctx,
        settings=_configured_settings(),
    )

    assert result.ok is True
    body = captured["json"]
    assert isinstance(body, dict)
    # Correct internal endpoint + service-secret header (server-to-server auth, fail-closed).
    assert captured["url"] == "http://api.test:3001/internal/assistant/tool"
    assert captured["headers"]["x-internal-secret"] == "test-secret-123"
    # The ToolInvokeRequest carries the TRUSTED context — never the smuggled identity.
    assert body["context"] == {"orgId": _ORG, "userId": _USER, "role": "EMPLOYEE"}
    # The smuggled identity keys are stripped from args entirely.
    assert "orgId" not in body["args"]
    assert "userId" not in body["args"]
    assert "role" not in body["args"]
    # The tool's own arg survives.
    assert body["args"]["question"] == "How much PTO do I get?"


# ═══ governance: a disallowed tool is refused without a network call ════════════
@pytest.mark.asyncio
async def test_dispatch_blocks_tool_not_permitted_for_role(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Defence in depth: even if the model emits a tool the role can't use, dispatch refuses
    it (ok:false) and never even calls the API."""
    import httpx

    called = {"n": 0}

    class _ExplodingClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            called["n"] += 1

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *_e: object) -> None:
            return None

        async def post(self, *_a: object, **_k: object):  # type: ignore[no-untyped-def]
            raise AssertionError("dispatch must not call the API for a disallowed tool")

    monkeypatch.setattr(httpx, "AsyncClient", _ExplodingClient)

    # EMPLOYEE attempting the HRBP/ADMIN-only attrition summary.
    result = await dispatch(
        "get_attrition_summary",
        {"department": "Engineering"},
        _ctx("EMPLOYEE"),
        settings=_configured_settings(),
    )
    assert result.ok is False
    assert "not permitted" in result.summary.lower()
    assert called["n"] == 0  # never constructed an httpx client


@pytest.mark.asyncio
async def test_dispatch_unknown_tool_returns_failed_result() -> None:
    result = await dispatch("not_a_real_tool", {}, _ctx("ADMIN"), settings=_configured_settings())
    assert result.ok is False
    assert "unknown tool" in result.summary.lower()


@pytest.mark.asyncio
async def test_dispatch_without_secret_degrades_to_failed_result() -> None:
    # No ai_service_secret -> the dispatcher cannot run; degrade (no crash), not raise.
    result = await dispatch(
        "answer_policy_question",
        {"question": "hi"},
        _ctx("EMPLOYEE"),
        settings=_offline_settings(),
    )
    assert result.ok is False
    assert "unavailable" in result.summary.lower()


@pytest.mark.asyncio
async def test_dispatch_http_error_degrades_to_failed_result(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import httpx

    class _ErrResponse:
        status_code = 403

    class _RaisingClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *_e: object) -> None:
            return None

        async def post(self, *_a: object, **_k: object):  # type: ignore[no-untyped-def]
            raise httpx.HTTPStatusError("403", request=None, response=_ErrResponse())  # type: ignore[arg-type]

    monkeypatch.setattr(httpx, "AsyncClient", _RaisingClient)
    result = await dispatch(
        "answer_policy_question",
        {"question": "hi"},
        _ctx("EMPLOYEE"),
        settings=_configured_settings(),
    )
    assert result.ok is False
    assert "error" in result.summary.lower()


@pytest.mark.asyncio
async def test_dispatch_propagates_dispatcher_ok_false(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """When the Node dispatcher itself refuses a tool (its authoritative governance), dispatch
    surfaces ok:false with the dispatcher's summary — not a crash."""
    import httpx

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"ok": False, "data": None, "summary": "Role not permitted for this tool.", "error": "forbidden"}

    class _FakeAsyncClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *_e: object) -> None:
            return None

        async def post(self, *_a: object, **_k: object):  # type: ignore[no-untyped-def]
            return _FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    # Use a role-permitted tool so we reach the API and exercise the ok:false path.
    result = await dispatch(
        "get_attrition_summary",
        {"department": "Engineering"},
        _ctx("HRBP"),
        settings=_configured_settings(),
    )
    assert result.ok is False
    assert "not permitted" in result.summary.lower()


# ═══ write tools are flagged for confirm-before-call ════════════════════════════
def test_write_tools_are_exactly_the_audited_actions() -> None:
    assert write_tool_names() == {"raise_hr_ticket", "generate_outreach", "start_workflow"}
    for name in write_tool_names():
        definition = tool_def(name)
        assert isinstance(definition, AssistantToolDef)
        assert definition.write is True
        # Their descriptions must instruct explicit-intent confirmation.
        assert "only call" in definition.description.lower()


# ═══ the ReAct loop ═════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_offline_returns_marked_tool_free_reply() -> None:
    # No ANTHROPIC_API_KEY -> the loop can't plan tools; a graceful, marked reply is returned.
    req = AssistantChatAiRequest(
        message="How much PTO do I have?",
        history=[],
        context=_ctx("EMPLOYEE"),
    )
    out = await run_assistant(req, settings=_offline_settings())
    assert "[OFFLINE]" in out.reply
    assert out.toolCalls == []
    # Even offline, the UI gets role-aware suggestions.
    assert out.suggestedActions == suggested_actions_for_role("EMPLOYEE")


@pytest.mark.asyncio
async def test_react_loop_runs_tool_then_answers_with_trace(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Turn 1 calls a tool; turn 2 answers. Assert the tool ran with the trusted context, the
    trace carries the short summary (no raw dump), and the reply is the model's final text."""
    import httpx
    from app.llm import LLMToolTurn, ToolUseBlock

    captured: dict[str, object] = {}

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "ok": True,
                "data": {"skills": ["Python", "SQL"]},
                "summary": "Loaded the user's skill profile (2 skills).",
                "error": None,
            }

    class _FakeAsyncClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *_e: object) -> None:
            return None

        async def post(self, url: str, *, json: dict[str, object], headers: dict[str, str]):  # type: ignore[no-untyped-def]
            captured["json"] = json
            return _FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    calls = {"n": 0}

    async def fake_call_llm_tools(**_kwargs: object) -> LLMToolTurn:
        calls["n"] += 1
        if calls["n"] == 1:
            return LLMToolTurn(
                stop_reason="tool_use",
                text="",
                tool_uses=[ToolUseBlock(id="tu_1", name="get_my_skill_profile", input={})],
                raw_content=[{"type": "tool_use", "id": "tu_1", "name": "get_my_skill_profile", "input": {}}],
            )
        return LLMToolTurn(
            stop_reason="end_turn",
            text="<thinking>secret reasoning</thinking>You have Python and SQL on your profile.",
            tool_uses=[],
            raw_content=[{"type": "text", "text": "You have Python and SQL on your profile."}],
        )

    monkeypatch.setattr(assistant_agent, "call_llm_tools", fake_call_llm_tools)

    req = AssistantChatAiRequest(
        message="What skills do I have?",
        history=[],
        context=_ctx("EMPLOYEE"),
    )
    out = await run_assistant(req, settings=_configured_settings())

    assert calls["n"] == 2  # one tool step + one final answer
    # The model's final text is returned, with <thinking> CoT stripped (standard #3).
    assert "Python and SQL" in out.reply
    assert "secret reasoning" not in out.reply
    # Exactly one tool invocation recorded, with the SHORT summary (no raw data dump).
    assert len(out.toolCalls) == 1
    assert out.toolCalls[0].tool == "get_my_skill_profile"
    assert out.toolCalls[0].ok is True
    assert out.toolCalls[0].summary == "Loaded the user's skill profile (2 skills)."
    # The raw skills list never leaks into the trace summary.
    assert "Python" not in out.toolCalls[0].summary
    # The tool was dispatched with the TRUSTED context (org/user/role from the request).
    assert captured["json"]["context"] == {"orgId": _ORG, "userId": _USER, "role": "EMPLOYEE"}  # type: ignore[index]
    assert out.suggestedActions == suggested_actions_for_role("EMPLOYEE")


@pytest.mark.asyncio
async def test_tool_error_does_not_crash_the_loop(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A tool that fails (dispatcher unreachable) is recorded ok:false and the loop continues
    to a final answer rather than crashing."""
    from app.llm import LLMToolTurn, ToolUseBlock

    calls = {"n": 0}

    async def fake_call_llm_tools(**_kwargs: object) -> LLMToolTurn:
        calls["n"] += 1
        if calls["n"] == 1:
            return LLMToolTurn(
                stop_reason="tool_use",
                text="",
                tool_uses=[ToolUseBlock(id="tu_1", name="answer_policy_question", input={"question": "PTO?"})],
                raw_content=[{"type": "tool_use", "id": "tu_1", "name": "answer_policy_question", "input": {"question": "PTO?"}}],
            )
        return LLMToolTurn(
            stop_reason="end_turn",
            text="I couldn't reach the policy tool just now; please try again shortly.",
            tool_uses=[],
            raw_content=[{"type": "text", "text": "I couldn't reach the policy tool just now; please try again shortly."}],
        )

    monkeypatch.setattr(assistant_agent, "call_llm_tools", fake_call_llm_tools)

    # ai_service_secret is None -> dispatch returns a failed ToolResult (no crash, no network).
    req = AssistantChatAiRequest(message="PTO policy?", history=[], context=_ctx("EMPLOYEE"))
    out = await run_assistant(req, settings=_offline_settings_with_no_secret())

    assert calls["n"] == 2  # the loop continued past the failed tool to the final answer
    assert len(out.toolCalls) == 1
    assert out.toolCalls[0].ok is False  # degraded gracefully
    assert "try again" in out.reply.lower()


def _offline_settings_with_no_secret() -> Settings:
    """Anthropic 'enabled' is irrelevant here (we stub call_llm_tools); no API secret so the
    tool dispatch fails closed and we assert the loop degrades rather than crashes."""
    return Settings(anthropic_api_key="stub-key", ai_service_secret=None)


@pytest.mark.asyncio
async def test_react_loop_is_capped(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A model that ALWAYS asks for a tool must not loop forever: the loop is capped and
    returns a bounded 'reached my step limit' reply with exactly cap-many tool calls."""
    import httpx
    from app.llm import LLMToolTurn, ToolUseBlock

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"ok": True, "data": None, "summary": "ok", "error": None}

    class _FakeAsyncClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *_e: object) -> None:
            return None

        async def post(self, *_a: object, **_k: object):  # type: ignore[no-untyped-def]
            return _FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    calls = {"n": 0}

    async def always_tool(**_kwargs: object) -> LLMToolTurn:
        calls["n"] += 1
        return LLMToolTurn(
            stop_reason="tool_use",
            text="",
            tool_uses=[ToolUseBlock(id=f"tu_{calls['n']}", name="get_my_skill_profile", input={})],
            raw_content=[{"type": "tool_use", "id": f"tu_{calls['n']}", "name": "get_my_skill_profile", "input": {}}],
        )

    monkeypatch.setattr(assistant_agent, "call_llm_tools", always_tool)

    # A small cap so the test is fast; assert we stop at exactly the cap.
    settings = Settings(anthropic_api_key="stub-key", ai_service_secret="s", chat_max_iterations=3)
    req = AssistantChatAiRequest(message="loop please", history=[], context=_ctx("EMPLOYEE"))
    out = await run_assistant(req, settings=settings)

    assert calls["n"] == 3  # exactly the cap — not unbounded
    assert "step limit" in out.reply.lower()
    assert len(out.toolCalls) == 3  # one trace entry per capped iteration


@pytest.mark.asyncio
async def test_history_is_threaded_into_the_loop(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """The prior conversation + new message reach the model as the running messages."""
    from app.llm import LLMToolTurn

    seen: dict[str, object] = {}

    async def capture(**kwargs: object) -> LLMToolTurn:
        seen["messages"] = kwargs["messages"]
        seen["system"] = kwargs["system"]
        return LLMToolTurn(stop_reason="end_turn", text="ack", tool_uses=[], raw_content=[{"type": "text", "text": "ack"}])

    monkeypatch.setattr(assistant_agent, "call_llm_tools", capture)

    req = AssistantChatAiRequest(
        message="and after that?",
        history=[
            {"role": "user", "content": "what's my PTO?"},
            {"role": "assistant", "content": "25 days."},
        ],
        context=_ctx("EMPLOYEE"),
    )
    out = await run_assistant(req, settings=Settings(anthropic_api_key="stub-key", ai_service_secret="s"))

    msgs = seen["messages"]
    assert isinstance(msgs, list)
    # history (2) + the new user message (1).
    assert len(msgs) == 3
    assert msgs[0]["content"] == "what's my PTO?"
    assert msgs[-1]["content"] == "and after that?"
    # The role is named in the system prompt (role-aware).
    assert "EMPLOYEE" in str(seen["system"])
    assert out.reply == "ack"


# ═══ truncated tool_use (stop_reason == "max_tokens") still runs the tool ════════
@pytest.mark.asyncio
async def test_truncated_tool_use_max_tokens_still_executes_tools(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A turn truncated at the token cap (stop_reason == "max_tokens") that still carries a
    complete tool_use block must be EXECUTED as a tool step, not silently dropped as a final
    answer (regression guard for the max_tokens gate)."""
    import httpx
    from app.llm import LLMToolTurn, ToolUseBlock

    posts = {"n": 0}

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"ok": True, "data": {"skills": []}, "summary": "Loaded profile.", "error": None}

    class _FakeAsyncClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *_e: object) -> None:
            return None

        async def post(self, *_a: object, **_k: object):  # type: ignore[no-untyped-def]
            posts["n"] += 1
            return _FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    calls = {"n": 0}

    async def fake_call(**_kwargs: object) -> LLMToolTurn:
        calls["n"] += 1
        if calls["n"] == 1:
            return LLMToolTurn(
                stop_reason="max_tokens",  # truncated mid-turn, but a complete tool_use survived
                text="",
                tool_uses=[ToolUseBlock(id="tu_1", name="get_my_skill_profile", input={})],
                raw_content=[{"type": "tool_use", "id": "tu_1", "name": "get_my_skill_profile", "input": {}}],
            )
        return LLMToolTurn(
            stop_reason="end_turn",
            text="Here is your profile.",
            tool_uses=[],
            raw_content=[{"type": "text", "text": "Here is your profile."}],
        )

    monkeypatch.setattr(assistant_agent, "call_llm_tools", fake_call)

    req = AssistantChatAiRequest(message="my skills?", history=[], context=_ctx("EMPLOYEE"))
    out = await run_assistant(req, settings=_configured_settings())

    assert calls["n"] == 2  # the truncated turn was a tool step, then the model answered
    assert posts["n"] == 1  # the tool actually dispatched (NOT dropped)
    assert len(out.toolCalls) == 1 and out.toolCalls[0].tool == "get_my_skill_profile"
    assert "profile" in out.reply.lower()


# ═══ final iteration must not fire an audited WRITE tool whose result is discarded ══
@pytest.mark.asyncio
async def test_final_iteration_defers_write_tool(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """On the LAST allowed iteration the model's WRITE/action tool must NOT fire (its result
    could never be observed/confirmed); it is deferred and the loop returns the cap reply."""
    import httpx
    from app.llm import LLMToolTurn, ToolUseBlock

    clients = {"n": 0}

    class _ExplodingClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            clients["n"] += 1

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *_e: object) -> None:
            return None

        async def post(self, *_a: object, **_k: object):  # type: ignore[no-untyped-def]
            raise AssertionError("a deferred WRITE tool must never be dispatched")

    monkeypatch.setattr(httpx, "AsyncClient", _ExplodingClient)

    async def always_write(**_kwargs: object) -> LLMToolTurn:
        return LLMToolTurn(
            stop_reason="tool_use",
            text="",
            tool_uses=[
                ToolUseBlock(
                    id="tu_1",
                    name="raise_hr_ticket",
                    input={"category": "ACTION", "description": "x"},
                )
            ],
            raw_content=[
                {
                    "type": "tool_use",
                    "id": "tu_1",
                    "name": "raise_hr_ticket",
                    "input": {"category": "ACTION", "description": "x"},
                }
            ],
        )

    monkeypatch.setattr(assistant_agent, "call_llm_tools", always_write)

    # max_iters == 1 → the only iteration IS the last one.
    settings = Settings(anthropic_api_key="stub-key", ai_service_secret="s", chat_max_iterations=1)
    req = AssistantChatAiRequest(message="raise a ticket", history=[], context=_ctx("EMPLOYEE"))
    out = await run_assistant(req, settings=settings)

    assert clients["n"] == 0  # never even built an httpx client — the write was deferred, not run
    assert "step limit" in out.reply.lower()
    assert len(out.toolCalls) == 1 and out.toolCalls[0].ok is False
    assert "defer" in out.toolCalls[0].summary.lower()


# ═══ identity-key stripping is case/separator insensitive (defence in depth) ════
def test_sanitise_args_strips_identity_variants() -> None:
    # Every spelling of an identity field is recognised…
    assert _is_identity_key("org_id") and _is_identity_key("Role") and _is_identity_key("ORGID")
    assert _is_identity_key("user_id") and _is_identity_key("User-Id") and _is_identity_key("orgId")
    # …but legitimate tool args are not.
    assert not _is_identity_key("question") and not _is_identity_key("jobId")
    assert not _is_identity_key("roleId")  # a roleId arg is NOT the identity 'role'
    # …and _sanitise_args drops only the identity variants, keeping real args.
    cleaned = _sanitise_args(
        {"question": "x", "org_id": "EVIL", "Role": "ADMIN", "USER_ID": "y", "jobId": "j"}
    )
    assert cleaned == {"question": "x", "jobId": "j"}
