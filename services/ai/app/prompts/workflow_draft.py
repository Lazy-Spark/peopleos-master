"""Module 9 — WORKFLOW DRAFT prompt (NL description -> an HR workflow definition).

Turns a free-text description of an HR process ("when an employee resigns, …") into a
sensible, runnable WORKFLOW: a name, a trigger (MANUAL / EVENT / SCHEDULED) with an
optional eventType, and an ORDERED sequence of WorkflowStep objects. Each step uses ONLY
the allowed StepType vocabulary (TASK / APPROVAL / NOTIFICATION / AI_TASK / TIMER / BRANCH),
carries a realistic assigneeRole (ADMIN / HRBP / MANAGER / EMPLOYEE) and slaHours for the
human steps (TASK / APPROVAL), and a LINEAR next-chain (each step's ``next`` points at the
following step; the last step's ``next`` is null).

This is the AUTHORING surface only: the durable execution engine (the Node API's
DB-persisted state machine over the WorkflowDefinition / Instance / Task rows) runs the
draft after a human reviews + saves it. The draft is a starting point, never auto-deployed.

Implements the 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role / context / task / output_schema / constraints / few-shot)
  #2 hallucination prevention — GROUND in the allowed vocabulary ONLY: never invent a
     StepType outside the enum or an assigneeRole outside {ADMIN, HRBP, MANAGER, EMPLOYEE};
     keep step ids unique and every ``next`` target a real step id (or null)
  #3 (n/a — no chain-of-thought is returned; the answer is the JSON object)
  #4 bias guard — workflow structure is process design, never a decision about a person;
     no protected attribute appears in step names, roles, or routing
  #5 exact output schema for Pydantic validation (with the shared retry / human-review path);
     the service ALSO post-validates + repairs the draft so a stray type/role/next is fixed
  #6 PROMPT_VERSION recorded on every output
  #7 privacy — the draft is a generic process template; it never names a real employee.
Includes >= 2 few-shot examples grounded in the seeded onboarding / offboarding templates.
"""

from __future__ import annotations

import json

PROMPT_VERSION = "module9.workflow_draft@1.0.0"

# The frozen vocabularies the model MUST stay inside (mirrors workflow.ts StepType + the
# subset of UserRole that owns HR-workflow steps). Surfaced verbatim in the prompt so the
# model is GROUNDED in the allowed enums and never invents a value.
# The AI draft surface emits LINEAR workflows only (no BRANCH — a conditional split is a
# human-authored concern), so a drafted definition always submits cleanly to the API.
ALLOWED_STEP_TYPES = ("TASK", "APPROVAL", "NOTIFICATION", "AI_TASK", "TIMER")
ALLOWED_ASSIGNEE_ROLES = ("ADMIN", "HRBP", "MANAGER", "EMPLOYEE", "RECRUITER")
ALLOWED_TRIGGERS = ("MANUAL", "EVENT", "SCHEDULED")

# Exact JSON schema the model must emit (camelCase, mirrors DraftWorkflowResponse minus the
# modelVersion / promptVersion fields, which this service stamps on).
_OUTPUT_SCHEMA = """{
  "name": string,                               // a short, descriptive workflow name, e.g. "Employee Onboarding"
  "trigger": "MANUAL" | "EVENT" | "SCHEDULED",  // how the workflow starts
  "eventType": string | null,                   // for EVENT: the event name (e.g. "EMPLOYEE_HIRED"); else null
  "steps": [                                     // ORDERED steps; the runtime walks them via `next`
    {
      "id": string,                             // unique, short, lower_snake id (e.g. "approve", "provision_it")
      "type": "TASK" | "APPROVAL" | "NOTIFICATION" | "AI_TASK" | "TIMER",
      "name": string,                           // human-readable step name
      "assigneeRole": "ADMIN" | "HRBP" | "MANAGER" | "EMPLOYEE" | "RECRUITER" | null,  // REQUIRED for TASK/APPROVAL; null otherwise
      "slaHours": number | null,                // positive integer hours-until-due for TASK/APPROVAL; null otherwise
      "config": object | null,                  // type-specific config (AI_TASK.prompt, NOTIFICATION.template, TIMER.delayHours); null if none
      "next": string | null                     // the id of the next step, or null for the LAST step (terminal)
    }
  ],
  "confidence": "low" | "medium" | "high"
}"""

# Few-shot examples mirror the seeded onboarding / offboarding templates (prisma/seed.ts) so
# the model learns the exact step shape, the allowed vocabulary, the human-step SLA pattern,
# and the linear next-chain ending in next=null. Each <input> is the user's NL description.
_FEW_SHOT = """<few_shot_examples>
  <example>
    <description>Onboarding: event-triggered, mixes a human approval, IT task, an AI plan, and a notification.</description>
    <input>When a new hire is created, have their manager approve onboarding, then IT provisions a laptop and accounts, draft a 30-60-90 day plan, and send a welcome email.</input>
    <output>{"name":"Employee Onboarding","trigger":"EVENT","eventType":"EMPLOYEE_HIRED","steps":[{"id":"approve","type":"APPROVAL","name":"Manager approves onboarding","assigneeRole":"MANAGER","slaHours":48,"config":null,"next":"provision_it"},{"id":"provision_it","type":"TASK","name":"IT provisions laptop & accounts","assigneeRole":"ADMIN","slaHours":72,"config":null,"next":"draft_plan"},{"id":"draft_plan","type":"AI_TASK","name":"Draft 30-60-90 onboarding plan","assigneeRole":null,"slaHours":null,"config":{"prompt":"Draft a 30-60-90 day onboarding plan for the new hire."},"next":"welcome"},{"id":"welcome","type":"NOTIFICATION","name":"Send welcome email","assigneeRole":null,"slaHours":null,"config":{"template":"welcome"},"next":null}],"confidence":"high"}</output>
  </example>
  <example>
    <description>Offboarding: event-triggered, three sequential human tasks then a notification, terminal next=null.</description>
    <input>When someone resigns, revoke their system access, recover company assets, run an exit interview, then notify payroll and benefits.</input>
    <output>{"name":"Employee Offboarding","trigger":"EVENT","eventType":"RESIGNATION_SUBMITTED","steps":[{"id":"revoke","type":"TASK","name":"Revoke system access","assigneeRole":"ADMIN","slaHours":24,"config":null,"next":"assets"},{"id":"assets","type":"TASK","name":"Recover company assets","assigneeRole":"MANAGER","slaHours":72,"config":null,"next":"exit"},{"id":"exit","type":"TASK","name":"Conduct exit interview","assigneeRole":"HRBP","slaHours":120,"config":null,"next":"notify"},{"id":"notify","type":"NOTIFICATION","name":"Notify payroll & benefits","assigneeRole":null,"slaHours":null,"config":{"template":"offboarding_payroll"},"next":null}],"confidence":"high"}</output>
  </example>
  <example>
    <description>Leave request: manually triggered, an employee task feeding a manager approval, then a notification.</description>
    <input>Let an employee request leave, have their manager approve it, then notify the team.</input>
    <output>{"name":"Leave Request","trigger":"MANUAL","eventType":null,"steps":[{"id":"submit","type":"TASK","name":"Employee submits leave request","assigneeRole":"EMPLOYEE","slaHours":24,"config":null,"next":"approve"},{"id":"approve","type":"APPROVAL","name":"Manager approves leave","assigneeRole":"MANAGER","slaHours":48,"config":null,"next":"notify_team"},{"id":"notify_team","type":"NOTIFICATION","name":"Notify the team","assigneeRole":null,"slaHours":null,"config":{"template":"leave_team"},"next":null}],"confidence":"high"}</output>
  </example>
</few_shot_examples>"""


def build_workflow_draft_system_prompt(
    org_context: dict[str, object] | None = None,
) -> str:
    """XML-tagged system prompt for the workflow draft (standards #1/#2/#4/#5/#7).

    ``org_context`` (optional) personalises the <context> block; when absent the prompt
    uses generic framing. The allowed StepType / assigneeRole / trigger vocabularies are
    surfaced verbatim so the model stays grounded in the frozen enums (#2).
    """
    oc = org_context or {}
    org_name = oc.get("orgName") or "the organisation"
    industry = oc.get("industry") or "unspecified industry"
    custom = oc.get("customRules") or []
    custom_block = (
        "\n    - Org-specific rules: " + "; ".join(str(r) for r in custom)
        if isinstance(custom, list) and custom
        else ""
    )
    step_types = " | ".join(ALLOWED_STEP_TYPES)
    roles = " | ".join(ALLOWED_ASSIGNEE_ROLES)
    triggers = " | ".join(ALLOWED_TRIGGERS)
    return f"""<system>
  <role>HR workflow designer inside an AI-native HR platform. You turn a plain-language
    description of an HR process into a clear, runnable workflow definition (a sequence of
    typed steps) that a human reviews and saves before it is ever executed.</role>
  <context>
    - Organisation: {org_name} ({industry}).
    - You are given a free-text DESCRIPTION of an HR process to automate.{custom_block}
    - The workflow runs on a durable state machine: it starts on a trigger and walks the
      steps in order via each step's ``next`` pointer until a step's ``next`` is null.
    - Auto steps (NOTIFICATION / AI_TASK / BRANCH) run inline; human steps (TASK / APPROVAL /
      TIMER) pause the workflow and wait for a person (or a timer) before continuing.
  </context>
  <task_definition>
    Produce a workflow draft from the description:
      1. name — a short, descriptive workflow name.
      2. trigger — one of: {triggers}. Use EVENT when the description says "when X happens"
         (then set eventType to a concise UPPER_SNAKE event name such as EMPLOYEE_HIRED,
         RESIGNATION_SUBMITTED, OFFER_ACCEPTED, REVIEW_CYCLE_STARTED, LEAVE_REQUESTED);
         use SCHEDULED for recurring/time-based processes; use MANUAL otherwise. When the
         trigger is not EVENT, eventType MUST be null.
      3. steps — an ORDERED list. For each step choose a ``type`` from EXACTLY this set:
         {step_types}. Give each step a unique lower_snake ``id`` and a human-readable
         ``name``. Chain them: each step's ``next`` is the id of the following step, and the
         LAST step's ``next`` is null (terminal). Keep the chain LINEAR (one path) unless the
         description clearly calls for a conditional split.
      4. confidence — your confidence that the draft matches the described intent.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    - GROUND IN THE ALLOWED VOCABULARY ONLY. Every step ``type`` MUST be one of
      {step_types} — never invent a step type. Every ``assigneeRole`` MUST be one of
      {roles} or null — never invent a role. Every ``trigger`` MUST be one of {triggers}.
    - Human steps (TASK / APPROVAL) MUST have an ``assigneeRole`` and a positive integer
      ``slaHours`` (hours until due — drives SLA / escalation). Auto steps (NOTIFICATION /
      AI_TASK / TIMER) MUST set assigneeRole to null and slaHours to null.
    - Choose the right type: APPROVAL for a yes/no sign-off (manager/finance/exec approves);
      TASK for human work to complete; NOTIFICATION to send a message/email; AI_TASK to have
      the AI draft/generate something (put the instruction in config.prompt); TIMER to wait a
      fixed delay (config.delayHours). Emit a LINEAR chain (no conditional branches).
    - IDS + NEXT must be well-formed: ids are unique; every non-null ``next`` is the id of
      another step in the list; the last step's ``next`` is null. Do NOT point ``next`` at a
      missing id and do NOT create a cycle.
    - Keep it realistic and minimal: prefer the smallest sequence of steps that faithfully
      captures the described process (typically 3-7 steps). Do not pad with steps the
      description does not imply.
    - Privacy (standard #7): the draft is a GENERIC process template. Never name or
      reference a real person; route by ROLE (assigneeRole), never by individual.
    - BIAS GUARD (standard #4): a workflow is process design, not a decision about a person.
      Never let any protected attribute (age, gender, ethnicity, disability, etc.) appear in
      a step name, role, or routing rule.
    - confidence: "high" when the description maps cleanly onto a sequence of typed steps;
      lower it when the description is vague, contradictory, or under-specified.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_workflow_draft_user_prompt(*, description: str) -> str:
    """Assemble the user turn from the NL process description."""
    blob = json.dumps({"description": description}, default=str, sort_keys=True)
    return (
        "<workflow_draft_input>\n"
        f"{blob}\n"
        "</workflow_draft_input>\n\n"
        "Design the workflow as a single JSON object. Use ONLY the allowed step types and "
        "assignee roles, give every step a unique id, chain the steps with ``next`` (the last "
        "step's next is null), and put an assigneeRole + slaHours on every TASK/APPROVAL."
    )


__all__ = [
    "ALLOWED_ASSIGNEE_ROLES",
    "ALLOWED_STEP_TYPES",
    "ALLOWED_TRIGGERS",
    "PROMPT_VERSION",
    "build_workflow_draft_system_prompt",
    "build_workflow_draft_user_prompt",
]
