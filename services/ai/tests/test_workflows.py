"""Unit tests for Module 9 — Workflow Automation Engine AI draft surface.

All tests run WITHOUT network:
  - the offline path (no ANTHROPIC_API_KEY) exercises the deterministic 3-4 step template
    (APPROVAL -> [AI_TASK] -> TASK -> NOTIFICATION), clearly marked, with a valid chain,
  - the LLM path is exercised by monkeypatching ``call_llm`` so we assert the grounding +
    repair plumbing: the description reaches the prompt; valid JSON is parsed; the draft is
    REPAIRED so every step.type is a valid StepType (an invalid one is fixed), every
    assigneeRole is a valid role (invalid dropped, human steps defaulted), step ids are
    unique, and the next-chain is well-formed (no dangling next; the last step is terminal).

camelCase wire shape throughout (the API has already Zod-validated the requests).
"""

from __future__ import annotations

import json

import pytest
from app.config import Settings
from app.schemas import DraftWorkflowRequest
from app.workflows import draft_workflow

_ORG = "00000000-0000-0000-0000-000000000001"
_PROMPT_VERSION = "module9.workflow_draft@1.0.0"

# The frozen vocabularies the draft must stay inside (mirror workflow.ts).
_STEP_TYPES = {"TASK", "APPROVAL", "NOTIFICATION", "AI_TASK", "TIMER", "BRANCH"}
_ASSIGNEE_ROLES = {"ADMIN", "HRBP", "MANAGER", "EMPLOYEE"}
_HUMAN_TYPES = {"TASK", "APPROVAL"}


def _offline_settings() -> Settings:
    """Settings with no Anthropic key — forces the deterministic offline fallback."""
    return Settings(anthropic_api_key=None)


def _online_settings() -> Settings:
    """Settings with a (fake) key so the surface takes the LLM path; call_llm is stubbed."""
    return Settings(anthropic_api_key="sk-test-not-real")


def _req(description: str) -> DraftWorkflowRequest:
    """A workflow-draft request for the given NL description."""
    return DraftWorkflowRequest(orgId=_ORG, description=description)


def _assert_well_formed(resp: object) -> None:
    """Shared invariants every draft (online or offline) MUST satisfy.

    - every step.type is a valid StepType,
    - every assigneeRole is a valid role or null; human steps (TASK/APPROVAL) have a role +
      a positive slaHours; auto steps have neither,
    - step ids are unique,
    - the next-chain is well-formed: every non-null next is a real step id, the last step's
      next is null, and there is exactly one terminal step.
    """
    steps = resp.steps  # type: ignore[attr-defined]
    assert steps, "a draft must have at least one step"

    ids = [s.id for s in steps]
    assert len(ids) == len(set(ids)), "step ids must be unique"
    id_set = set(ids)

    for s in steps:
        assert s.type in _STEP_TYPES, f"invalid step type: {s.type}"
        if s.type in _HUMAN_TYPES:
            assert s.assigneeRole in _ASSIGNEE_ROLES, f"human step missing valid role: {s}"
            assert s.slaHours is not None and s.slaHours > 0, f"human step missing SLA: {s}"
        else:
            assert s.assigneeRole is None, f"auto step must have no role: {s}"
            assert s.slaHours is None, f"auto step must have no SLA: {s}"
        if s.assigneeRole is not None:
            assert s.assigneeRole in _ASSIGNEE_ROLES

    # next-chain: no dangling next; the LAST step is terminal.
    for s in steps[:-1]:
        if s.next is not None:
            assert s.next in id_set, f"dangling next pointer: {s.next}"
    assert steps[-1].next is None, "the last step must be terminal (next=null)"


# ═══ Offline fallback — works with no key, valid 3-4 step template ══════════════════════
@pytest.mark.asyncio
async def test_offline_fallback_builds_valid_template() -> None:
    """Offline (no key): a clearly-marked APPROVAL -> TASK -> NOTIFICATION template."""
    resp = await draft_workflow(
        _req("Process an expense reimbursement request from an employee."),
        settings=_offline_settings(),
    )

    # Clearly-marked offline output.
    assert "+offline_fallback" in resp.modelVersion
    assert resp.promptVersion == _PROMPT_VERSION
    assert "[OFFLINE]" in resp.name
    assert resp.confidence == "low"

    _assert_well_formed(resp)
    # The generic template leads with an approval and ends with a notification.
    assert resp.steps[0].type == "APPROVAL"
    assert resp.steps[-1].type == "NOTIFICATION"
    types = {s.type for s in resp.steps}
    assert "TASK" in types


@pytest.mark.asyncio
async def test_offline_fallback_infers_event_trigger() -> None:
    """A "when X happens" description offline -> an EVENT trigger with an eventType."""
    resp = await draft_workflow(
        _req("When an employee resigns, revoke access and notify payroll."),
        settings=_offline_settings(),
    )
    assert resp.trigger == "EVENT"
    assert resp.eventType == "RESIGNATION_SUBMITTED"
    _assert_well_formed(resp)


@pytest.mark.asyncio
async def test_offline_fallback_adds_ai_task_when_generation_implied() -> None:
    """A description implying generation offline -> the template includes an AI_TASK step."""
    resp = await draft_workflow(
        _req("When a candidate accepts, draft and send a personalised offer letter."),
        settings=_offline_settings(),
    )
    types = [s.type for s in resp.steps]
    assert "AI_TASK" in types
    # The AI_TASK carries a config.prompt instruction.
    ai_step = next(s for s in resp.steps if s.type == "AI_TASK")
    assert ai_step.config is not None and ai_step.config.get("prompt")
    _assert_well_formed(resp)


# ═══ LLM path — grounding + repair ENFORCED (call_llm stubbed; no network) ══════════════
@pytest.mark.asyncio
async def test_llm_path_repairs_invalid_step_type(monkeypatch: pytest.MonkeyPatch) -> None:
    """A model that emits an INVALID step type has it repaired to a valid StepType.

    The stub returns a bogus type ("EMAIL") which must be coerced (to TASK), so the draft
    only ever surfaces valid StepTypes.
    """
    seen: dict[str, str] = {}

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        seen["user"] = req.user  # type: ignore[attr-defined]
        return json.dumps(
            {
                "name": "Employee Onboarding",
                "trigger": "EVENT",
                "eventType": "EMPLOYEE_HIRED",
                "steps": [
                    {
                        "id": "approve",
                        "type": "APPROVAL",
                        "name": "Manager approves onboarding",
                        "assigneeRole": "MANAGER",
                        "slaHours": 48,
                        "next": "send_email",
                    },
                    {
                        # INVALID type — must be repaired to a valid StepType (TASK).
                        "id": "send_email",
                        "type": "EMAIL",
                        "name": "Send welcome email",
                        "assigneeRole": None,
                        "slaHours": None,
                        "next": None,
                    },
                ],
                "confidence": "high",
            }
        )

    monkeypatch.setattr("app.workflows.draft.call_llm", _fake_call_llm)
    resp = await draft_workflow(
        _req("When a new hire is created, approve onboarding then send a welcome email."),
        settings=_online_settings(),
    )

    # The description reached the prompt.
    assert "welcome email" in seen["user"]
    # LLM path (not the offline marker).
    assert resp.modelVersion == "claude-sonnet-4-6"
    assert "+offline_fallback" not in resp.modelVersion
    assert resp.promptVersion == _PROMPT_VERSION

    # The invalid type was repaired; every type is valid.
    for s in resp.steps:
        assert s.type in _STEP_TYPES
    repaired = next(s for s in resp.steps if s.id == "send_email")
    assert repaired.type == "TASK"  # "EMAIL" coerced to the generic human task
    _assert_well_formed(resp)


@pytest.mark.asyncio
async def test_llm_path_repairs_invalid_role_and_defaults_human_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An invalid assigneeRole is dropped; a human step left without a role is defaulted."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        return json.dumps(
            {
                "name": "Leave Request",
                "trigger": "MANUAL",
                "eventType": None,
                "steps": [
                    {
                        # INVALID role ("CEO") on a human step -> dropped then defaulted.
                        "id": "submit",
                        "type": "TASK",
                        "name": "Employee submits leave",
                        "assigneeRole": "CEO",
                        "slaHours": 24,
                        "next": "approve",
                    },
                    {
                        # Human step with NO role -> defaulted (so it always has an owner).
                        "id": "approve",
                        "type": "APPROVAL",
                        "name": "Manager approves leave",
                        "assigneeRole": None,
                        "slaHours": None,  # missing SLA -> defaulted to a positive value
                        "next": None,
                    },
                ],
                "confidence": "high",
            }
        )

    monkeypatch.setattr("app.workflows.draft.call_llm", _fake_call_llm)
    resp = await draft_workflow(_req("Employee requests leave, manager approves."), settings=_online_settings())

    by_id = {s.id: s for s in resp.steps}
    # The invalid role was dropped and replaced by a valid default (never "CEO").
    assert by_id["submit"].assigneeRole in _ASSIGNEE_ROLES
    assert by_id["submit"].assigneeRole != "CEO"
    # The role-less human step was given a valid owner + a positive SLA.
    assert by_id["approve"].assigneeRole in _ASSIGNEE_ROLES
    assert by_id["approve"].slaHours is not None and by_id["approve"].slaHours > 0
    _assert_well_formed(resp)


@pytest.mark.asyncio
async def test_llm_path_repairs_dangling_next_and_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dangling ``next`` is rewritten to the following step; the last step is forced terminal."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        return json.dumps(
            {
                "name": "Offboarding",
                "trigger": "EVENT",
                "eventType": "RESIGNATION_SUBMITTED",
                "steps": [
                    {
                        # next points at a MISSING id -> repaired to the following step.
                        "id": "revoke",
                        "type": "TASK",
                        "name": "Revoke access",
                        "assigneeRole": "ADMIN",
                        "slaHours": 24,
                        "next": "does_not_exist",
                    },
                    {
                        "id": "assets",
                        "type": "TASK",
                        "name": "Recover assets",
                        "assigneeRole": "MANAGER",
                        "slaHours": 72,
                        # last step wrongly points forward -> forced terminal (null).
                        "next": "ghost",
                    },
                ],
                "confidence": "medium",
            }
        )

    monkeypatch.setattr("app.workflows.draft.call_llm", _fake_call_llm)
    resp = await draft_workflow(_req("When someone resigns, revoke access and recover assets."), settings=_online_settings())

    by_id = {s.id: s for s in resp.steps}
    # The dangling next was rewritten to the next step in document order.
    assert by_id["revoke"].next == "assets"
    # The last step is terminal regardless of what the model emitted.
    assert resp.steps[-1].next is None
    _assert_well_formed(resp)


@pytest.mark.asyncio
async def test_llm_path_makes_duplicate_ids_unique(monkeypatch: pytest.MonkeyPatch) -> None:
    """Duplicate step ids are made unique (a clash is suffixed)."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        return json.dumps(
            {
                "name": "Generic Process",
                "trigger": "MANUAL",
                "eventType": None,
                "steps": [
                    {"id": "step", "type": "APPROVAL", "name": "Approve", "assigneeRole": "MANAGER", "slaHours": 24, "next": "step"},
                    {"id": "step", "type": "NOTIFICATION", "name": "Notify", "assigneeRole": None, "slaHours": None, "next": None},
                ],
                "confidence": "low",
            }
        )

    monkeypatch.setattr("app.workflows.draft.call_llm", _fake_call_llm)
    resp = await draft_workflow(_req("Approve then notify."), settings=_online_settings())

    ids = [s.id for s in resp.steps]
    assert len(ids) == len(set(ids)), "duplicate ids must be made unique"
    _assert_well_formed(resp)


@pytest.mark.asyncio
async def test_llm_path_clears_event_type_for_non_event_trigger(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-EVENT trigger forces eventType to null even if the model supplied one."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        return json.dumps(
            {
                "name": "Manual Process",
                "trigger": "MANUAL",
                "eventType": "SHOULD_BE_CLEARED",  # invalid for MANUAL -> cleared
                "steps": [
                    {"id": "do_it", "type": "TASK", "name": "Do the work", "assigneeRole": "HRBP", "slaHours": 48, "next": None},
                ],
                "confidence": "medium",
            }
        )

    monkeypatch.setattr("app.workflows.draft.call_llm", _fake_call_llm)
    resp = await draft_workflow(_req("Have HR do the work."), settings=_online_settings())

    assert resp.trigger == "MANUAL"
    assert resp.eventType is None
    _assert_well_formed(resp)


@pytest.mark.asyncio
async def test_llm_path_coerces_invalid_trigger(monkeypatch: pytest.MonkeyPatch) -> None:
    """An invalid trigger is coerced to a valid WorkflowTrigger (MANUAL)."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        return json.dumps(
            {
                "name": "Bad Trigger",
                "trigger": "WEBHOOK",  # not a valid trigger -> MANUAL
                "eventType": None,
                "steps": [
                    {"id": "notify", "type": "NOTIFICATION", "name": "Notify", "assigneeRole": None, "slaHours": None, "next": None},
                ],
                "confidence": "low",
            }
        )

    monkeypatch.setattr("app.workflows.draft.call_llm", _fake_call_llm)
    resp = await draft_workflow(_req("Notify someone."), settings=_online_settings())
    assert resp.trigger == "MANUAL"
    _assert_well_formed(resp)
