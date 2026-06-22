"""Module 9 — WORKFLOW DRAFT (turn an NL description into a runnable HR workflow).

LLM path (prompt standards #1/#2/#4/#5/#6/#7): build the XML-tagged system prompt
(optionally personalised with orgContext), pass the free-text process description, call
Claude, and validate the JSON against an internal Pydantic model with the shared retry /
human-review path.

GROUNDING + REPAIR is enforced in code, not merely instructed (standards #2/#5). Regardless
of what the model returns, ``_repair_draft`` makes the draft runnable:
  - every step ``type`` is coerced to a valid StepType (an invalid type defaults to TASK,
    a generic human step) so the engine never sees an unknown type;
  - every ``assigneeRole`` is validated against {ADMIN, HRBP, MANAGER, EMPLOYEE} — an invalid
    role is dropped (set to null); human steps (TASK/APPROVAL) missing a role default to HRBP
    so a human step always has an owner;
  - human steps get a positive ``slaHours`` (default 48) and auto steps have slaHours/
    assigneeRole cleared, mirroring the seeded templates;
  - step ids are made unique (a duplicate id is suffixed) and every ``next`` is repaired to a
    valid target: a dangling ``next`` (points at a missing id) is rewritten to the next step
    in document order, and the LAST step's ``next`` is forced to null — so the chain is always
    well-formed (no dangling next, terminal end).
The repair NEVER trusts the model blindly: it is the source of truth for a runnable draft.

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a deterministic, clearly-marked 3-4 step template
(APPROVAL -> TASK -> NOTIFICATION, plus an AI_TASK when the description implies generation)
derived from the description. modelVersion is then suffixed ``+offline_fallback``.
"""

from __future__ import annotations

import re

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.workflow_draft import (
    ALLOWED_ASSIGNEE_ROLES,
    ALLOWED_STEP_TYPES,
    ALLOWED_TRIGGERS,
    PROMPT_VERSION,
    build_workflow_draft_system_prompt,
    build_workflow_draft_user_prompt,
)
from ..schemas import (
    BranchRule,
    Confidence,
    DraftWorkflowRequest,
    DraftWorkflowResponse,
    WorkflowStep,
    WorkflowTrigger,
)
from ..validation import validate_or_review

log = structlog.get_logger(__name__)

# Frozen vocabularies (mirror workflow.ts). Kept as sets for O(1) membership in the repair.
_STEP_TYPES: frozenset[str] = frozenset(ALLOWED_STEP_TYPES)
_ASSIGNEE_ROLES: frozenset[str] = frozenset(ALLOWED_ASSIGNEE_ROLES)
_TRIGGERS: frozenset[str] = frozenset(ALLOWED_TRIGGERS)

# Step types that represent human work and therefore require an owner + an SLA.
_HUMAN_STEP_TYPES: frozenset[str] = frozenset({"TASK", "APPROVAL"})

# Repair defaults.
_DEFAULT_STEP_TYPE = "TASK"  # an unknown type degrades to a generic human task
_DEFAULT_ASSIGNEE_ROLE = "HRBP"  # a human step missing a role gets an HR business partner
_DEFAULT_SLA_HOURS = 48  # a human step missing an SLA gets a sane 2-business-day default

_ID_SAFE_RE = re.compile(r"[^a-z0-9_]+")


class _LenientStep(BaseModel):
    """A deliberately permissive step shape for PARSING the model's raw JSON.

    Unlike the frozen ``WorkflowStep`` (whose ``type`` is a StepType Literal and whose
    ``assigneeRole`` is a UserRole Literal), this accepts ``type`` / ``assigneeRole`` /
    ``trigger`` as plain strings so a stray invalid value (e.g. type "EMAIL", role "CEO")
    SURVIVES Pydantic and reaches ``_repair_draft`` to be fixed — rather than being rejected
    and pointlessly routed to human review. The repair converts each lenient step into a
    valid frozen ``WorkflowStep``.
    """

    id: str = ""
    type: str = _DEFAULT_STEP_TYPE
    name: str = ""
    assigneeRole: str | None = None
    slaHours: int | None = None
    config: dict[str, object] | None = None
    next: str | None = None
    branches: list[BranchRule] | None = None


class _DraftContent(BaseModel):
    """Internal validation model for the model's JSON (content only).

    The version fields are stamped on by this module and the steps are re-grounded /
    repaired after validation, so this is a lean subset of ``DraftWorkflowResponse``. The
    ``steps`` are parsed as ``_LenientStep`` so a stray invalid type/role reaches
    ``_repair_draft`` to be fixed rather than rejected by Pydantic.
    """

    name: str
    trigger: str
    eventType: str | None = None
    steps: list[_LenientStep] = Field(default_factory=list)
    confidence: Confidence = "medium"


# ── Repair helpers ──────────────────────────────────────────────────────────────────────
def _coerce_trigger(raw: str) -> WorkflowTrigger:
    """Coerce the trigger to a valid WorkflowTrigger (default MANUAL)."""
    value = (raw or "").strip().upper()
    return value if value in _TRIGGERS else "MANUAL"  # type: ignore[return-value]


def _coerce_step_type(raw: str) -> str:
    """Coerce a step type to a valid StepType; an invalid one becomes a generic TASK."""
    value = (raw or "").strip().upper()
    return value if value in _STEP_TYPES else _DEFAULT_STEP_TYPE


def _coerce_assignee_role(raw: str | None) -> str | None:
    """Validate an assignee role against the allowed set; drop (None) an invalid one."""
    if raw is None:
        return None
    value = str(raw).strip().upper()
    return value if value in _ASSIGNEE_ROLES else None


def _slugify_id(raw: str, fallback: str) -> str:
    """Normalise a step id to a short lower_snake token; fall back when empty."""
    slug = _ID_SAFE_RE.sub("_", (raw or "").strip().lower()).strip("_")
    return slug or fallback


def _repair_step(step: _LenientStep, *, index: int, used_ids: set[str]) -> WorkflowStep:
    """Repair one lenient parsed step into a valid frozen ``WorkflowStep``.

    - ``type`` is coerced to a valid StepType (unknown -> TASK).
    - ``assigneeRole`` is validated; for a human step a missing/invalid role defaults to
      HRBP, for an auto step the role is cleared (null).
    - ``slaHours`` is forced to a positive int for human steps (default 48) and cleared for
      auto steps — mirroring the seeded templates.
    - ``id`` is slugified and made unique within the draft (a clash is suffixed).
    - ``name`` falls back to the (final) id when the model omitted it.
    The frozen ``WorkflowStep`` constructor below is what guarantees the emitted step is
    contract-valid (its Literal fields reject anything the coercion let through). ``next`` is
    repaired in the second pass once all final ids are known.
    """
    step_type = _coerce_step_type(step.type)
    is_human = step_type in _HUMAN_STEP_TYPES

    role = _coerce_assignee_role(step.assigneeRole)
    if is_human:
        role = role or _DEFAULT_ASSIGNEE_ROLE
        sla = step.slaHours if (step.slaHours is not None and step.slaHours > 0) else _DEFAULT_SLA_HOURS
    else:
        # Auto steps own no person and carry no SLA timer.
        role = None
        sla = None

    base_id = _slugify_id(step.id, fallback=f"step_{index + 1}")
    unique_id = base_id
    suffix = 2
    while unique_id in used_ids:
        unique_id = f"{base_id}_{suffix}"
        suffix += 1
    used_ids.add(unique_id)

    return WorkflowStep(
        id=unique_id,
        type=step_type,  # type: ignore[arg-type]  # coerced into the StepType set above
        name=step.name.strip() or unique_id,
        assigneeRole=role,  # validated into the allowed role set above
        slaHours=sla,
        config=step.config,
        next=step.next,  # repaired in the 2nd pass once all ids are final
        branches=step.branches,
    )


def _repair_next_chain(steps: list[WorkflowStep]) -> list[WorkflowStep]:
    """Repair the next-chain so it is well-formed: no dangling ``next``, terminal end.

    - A ``next`` that points at a real (final) step id is kept.
    - A non-null ``next`` that points at a MISSING id is rewritten to the following step in
      document order (or null if this is the last step) — so the chain never dangles.
    - The LAST step's ``next`` is forced to null (terminal).
    BRANCH targets are not synthesised here (the draft surface emits linear chains); a branch
    that points backwards is still a valid id reference and is left intact by the engine's
    own revisit guard.
    """
    valid_ids = {s.id for s in steps}
    repaired: list[WorkflowStep] = []
    for i, step in enumerate(steps):
        is_last = i == len(steps) - 1
        fallback_next = None if is_last else steps[i + 1].id

        next_id = step.next
        if is_last:
            next_id = None
        elif next_id is None:
            # A non-terminal step with no next would strand the rest of the chain.
            next_id = fallback_next
        elif next_id not in valid_ids:
            # Dangling pointer -> route to the next step in document order.
            next_id = fallback_next

        repaired.append(step.model_copy(update={"next": next_id}))
    return repaired


def _repair_draft(content: _DraftContent) -> tuple[WorkflowTrigger, str | None, list[WorkflowStep]]:
    """Make the model's draft runnable: valid types/roles, unique ids, well-formed chain.

    Returns the repaired ``(trigger, eventType, steps)``. Pure + deterministic so it is
    equally the post-validate guard for the LLM path and reusable for tests.
    """
    trigger = _coerce_trigger(content.trigger)
    # eventType is only meaningful for EVENT triggers; clear it otherwise.
    event_type = (content.eventType or None) if trigger == "EVENT" else None

    used_ids: set[str] = set()
    repaired_steps = [
        _repair_step(step, index=i, used_ids=used_ids) for i, step in enumerate(content.steps)
    ]
    repaired_steps = _repair_next_chain(repaired_steps)
    return trigger, event_type, repaired_steps


# ── Offline deterministic fallback (clearly marked) ─────────────────────────────────────
_GENERATION_HINTS = ("draft", "generat", "write", "compose", "summar", "letter", "plan")
_EVENT_HINTS: tuple[tuple[str, str], ...] = (
    ("resign", "RESIGNATION_SUBMITTED"),
    ("terminat", "TERMINATION_CREATED"),
    ("offboard", "RESIGNATION_SUBMITTED"),
    ("hire", "EMPLOYEE_HIRED"),
    ("onboard", "EMPLOYEE_HIRED"),
    ("new hire", "EMPLOYEE_HIRED"),
    ("offer accept", "OFFER_ACCEPTED"),
    ("offer", "OFFER_EXTENDED"),
    ("review", "REVIEW_CYCLE_STARTED"),
    ("leave", "LEAVE_REQUESTED"),
)


def _infer_event(description: str) -> tuple[WorkflowTrigger, str | None]:
    """Best-effort trigger inference for the offline template (keyword match)."""
    text = description.lower()
    if "when " in text or "after " in text or "once " in text:
        for needle, event in _EVENT_HINTS:
            if needle in text:
                return "EVENT", event
        return "EVENT", "WORKFLOW_TRIGGERED"
    return "MANUAL", None


def _offline_name(description: str) -> str:
    """A short workflow name derived from the description (clearly marked)."""
    snippet = " ".join(description.strip().split())[:48].rstrip(" ,.;:")
    return f"[OFFLINE] {snippet}" if snippet else "[OFFLINE] HR Workflow"


def _offline_steps(description: str) -> list[WorkflowStep]:
    """A generic 3-4 step template: APPROVAL -> [AI_TASK] -> TASK -> NOTIFICATION.

    The optional AI_TASK is included only when the description implies generating content
    (so the template stays minimal otherwise). Every step is grounded in the allowed
    vocabulary, human steps carry a role + SLA, and the chain is linear ending in next=null.
    """
    text = description.lower()
    wants_generation = any(hint in text for hint in _GENERATION_HINTS)

    steps: list[WorkflowStep] = [
        WorkflowStep(
            id="approve",
            type="APPROVAL",
            name="Manager approves the request",
            assigneeRole="MANAGER",
            slaHours=48,
            next=None,
        ),
    ]
    if wants_generation:
        steps.append(
            WorkflowStep(
                id="ai_draft",
                type="AI_TASK",
                name="AI drafts the required content",
                config={"prompt": f"Draft the content for: {description.strip()}"},
                next=None,
            )
        )
    steps.append(
        WorkflowStep(
            id="execute",
            type="TASK",
            name="Complete the required work",
            assigneeRole="HRBP",
            slaHours=72,
            next=None,
        )
    )
    steps.append(
        WorkflowStep(
            id="notify",
            type="NOTIFICATION",
            name="Notify stakeholders",
            config={"template": "workflow_complete"},
            next=None,
        )
    )
    # Wire the linear chain (each step -> the next; last -> null) deterministically.
    for i, step in enumerate(steps[:-1]):
        steps[i] = step.model_copy(update={"next": steps[i + 1].id})
    return steps


def _offline_response(req: DraftWorkflowRequest, settings: Settings) -> DraftWorkflowResponse:
    """Assemble the deterministic offline draft (clearly marked)."""
    trigger, event_type = _infer_event(req.description)
    steps = _offline_steps(req.description)
    return DraftWorkflowResponse(
        name=_offline_name(req.description),
        trigger=trigger,
        eventType=event_type,
        steps=steps,
        # The offline template is a generic skeleton, never a confident match to intent.
        confidence="low",
        modelVersion=f"{settings.model_version}+offline_fallback",
        promptVersion=PROMPT_VERSION,
    )


async def draft_workflow(
    req: DraftWorkflowRequest, *, settings: Settings | None = None
) -> DraftWorkflowResponse:
    """Draft a workflow definition from a free-text description (spec Module 9).

    GROUNDED in the allowed vocabulary and REPAIRED in code (standards #2/#5): every step's
    ``type`` is a valid StepType, every ``assigneeRole`` is a valid role (invalid dropped /
    human steps defaulted), ids are unique, and the next-chain is well-formed (no dangling
    next; the last step is terminal). Offline (no ANTHROPIC_API_KEY): a deterministic,
    clearly-marked 3-4 step template derived from the description.
    """
    settings = settings or get_settings()
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None

    system = build_workflow_draft_system_prompt(org_context=org_context)
    user = build_workflow_draft_user_prompt(description=req.description)

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1800,
                temperature=0.2,  # structured authoring, kept grounded
                run_name="module9.workflow_draft",
                tags=["module9", "workflow", "draft", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _DraftContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "description": req.description},
            module="module9",
            task="workflow_draft",
        )
    except LLMUnavailable:
        log.info("workflow_draft_offline_fallback", orgId=req.orgId)
        return _offline_response(req, settings)

    # Enforce grounding + repair regardless of the model's output so the draft is runnable.
    trigger, event_type, steps = _repair_draft(content)
    return DraftWorkflowResponse(
        name=content.name,
        trigger=trigger,
        eventType=event_type,
        steps=steps,
        confidence=content.confidence,
        modelVersion=settings.model_version,
        promptVersion=PROMPT_VERSION,
    )


__all__ = ["draft_workflow"]
