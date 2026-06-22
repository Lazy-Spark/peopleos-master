"""Module 10 — Agentic HR Assistant tool REGISTRY + dispatcher.

Each tool is described by an ``AssistantToolDef``:
  - ``name``         the canonical AssistantTool vocabulary value (assistant.ts, FROZEN)
  - ``description``  what the model reads to decide when to call it
  - ``input_schema`` a JSON schema of the tool's OWN arguments ONLY — it NEVER contains
                     orgId / userId / role. Identity comes EXCLUSIVELY from the trusted
                     AssistantContext, attached by the agent loop PROGRAMMATICALLY.
  - ``allowed_roles``the server-side role allowlist. ``tools_for_role(role)`` uses this so
                     the model only ever SEES the tools its role may use (defence in depth).
  - ``write``        True for AUDITED action tools (raise_hr_ticket, start_workflow,
                     generate_outreach) — the agent must CONFIRM intent before calling.

THE TRUST BOUNDARY (do NOT weaken):
  - ``tools_for_role`` is the FIRST gate (the model can't pick a tool it can't see), but it
    is NOT the security boundary. The AUTHORITATIVE allowlist is the Node API's
    ``/internal/assistant/tool`` dispatcher, which RE-DERIVES the per-tool role gate from
    ``context.role`` and re-runs each module's own governance. A disallowed tool returns
    ok:false there even if the agent somehow emitted it.
  - ``dispatch`` POSTs ``ToolInvokeRequest { tool, args, context }`` with the
    ``x-internal-secret`` header. ``context`` is the trusted AssistantContext from the
    REQUEST — never anything the model produced. We strip any identity keys a (prompt-
    injected) model might smuggle into ``args`` before sending, so they cannot shadow the
    trusted context even if the dispatcher were lenient.

OFFLINE/UNCONFIGURED: when ``ai_service_secret`` is unset, ``dispatch`` returns a failed
ToolResult (the agent records the tool as failed and continues) rather than crashing.
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog

from ..config import Settings, get_settings
from ..schemas import AssistantContext, ToolInvokeResponse

log = structlog.get_logger(__name__)

# Identity keys that must NEVER originate from the model / tool args. If a prompt-injected
# model tries to smuggle one into ``args``, we drop it before dispatch so it can never
# shadow the trusted AssistantContext (belt-and-braces with the dispatcher's own re-derive).
_FORBIDDEN_ARG_KEYS = frozenset({"orgId", "userId", "role", "orgid", "userid"})

# Normalised identity tokens (lower-cased, separators removed) so the strip catches every
# spelling a prompt-injected model might try: Role, ORGID, org_id, user_id, OrgId, …
_IDENTITY_TOKENS = frozenset({"orgid", "userid", "role"})


def _is_identity_key(key: str) -> bool:
    """True if a tool-arg key is an identity field in ANY spelling (case/separator-insensitive)."""
    return key.lower().replace("_", "").replace("-", "") in _IDENTITY_TOKENS

# Role groups (mirror the @peopleos/schemas assistant.ts FROZEN gate comments). The Node
# dispatcher is the authoritative copy; this is the agent-side view used purely to FILTER
# which tools the model sees. Using sets keeps membership checks O(1) and order-independent.
_ALL_ROLES = ("ADMIN", "RECRUITER", "HRBP", "MANAGER", "EMPLOYEE")
_RECRUITER_PEOPLE = ("ADMIN", "HRBP", "RECRUITER")
_MANAGER_PEOPLE = ("ADMIN", "HRBP", "MANAGER")
_PEOPLE_ADMIN = ("ADMIN", "HRBP")


class ToolUnavailable(RuntimeError):
    """Raised internally when dispatch cannot run (no secret / transport error)."""


class ToolError(RuntimeError):
    """Raised internally when the internal API returns a non-2xx / unparseable response."""


@dataclass(slots=True)
class ToolResult:
    """Outcome of one tool dispatch, surfaced into the agent's ToolCallTrace.

    ``summary`` is the SHORT, non-sensitive summary from ToolInvokeResponse.summary (NEVER
    a raw data dump). ``data`` is the structured payload fed back to the model as the
    observation so it can answer precisely — it never reaches the trace.
    """

    ok: bool
    summary: str
    data: object | None = None


@dataclass(slots=True)
class AssistantToolDef:
    """One registry entry. ``input_schema`` is the tool's OWN args only (no identity)."""

    name: str
    description: str
    input_schema: dict[str, object]
    allowed_roles: tuple[str, ...]
    write: bool = False

    def anthropic_schema(self) -> dict[str, object]:
        """The Anthropic ``tools`` entry (name + description + input_schema)."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


def _obj_schema(
    properties: dict[str, object] | None = None,
    required: list[str] | None = None,
) -> dict[str, object]:
    """Build a JSON-Schema object for a tool's OWN args. Identity keys are forbidden here."""
    props = properties or {}
    # Defensive: a registry entry must never declare an identity field as a tool arg.
    for key in props:
        if key in _FORBIDDEN_ARG_KEYS:
            raise ValueError(
                f"Tool input_schema must not declare identity field {key!r}; "
                "orgId/userId/role come only from AssistantContext."
            )
    return {"type": "object", "properties": props, "required": required or []}


# ── THE REGISTRY ──────────────────────────────────────────────────────────────
# Roles per tool mirror the assistant.ts gate comments EXACTLY:
#   all roles:        answer_policy_question, raise_hr_ticket, get_my_skill_profile,
#                     get_skill_gap, recommended_roles, list_my_tasks
#   recruiter+people: rank_candidates, draft_jd, generate_outreach, find_internal_candidates
#   manager+people:   get_employee_attrition, get_team_skill_map
#   HRBP/ADMIN:       get_analytics_dashboard, ask_workforce_data, get_attrition_summary,
#                     get_succession, get_skill_inventory, draft_workflow, start_workflow
_REGISTRY: tuple[AssistantToolDef, ...] = (
    # ── Available to ALL roles (self-service) ─────────────────────────────────
    AssistantToolDef(
        name="answer_policy_question",
        description=(
            "Answer an HR/policy question using the organisation's policy knowledge base "
            "(RAG over company documents). Returns a grounded answer with citations. Use "
            "this for handbook/PTO/benefits/conduct questions."
        ),
        input_schema=_obj_schema(
            {"question": {"type": "string", "description": "The policy question to answer."}},
            ["question"],
        ),
        allowed_roles=_ALL_ROLES,
    ),
    AssistantToolDef(
        name="raise_hr_ticket",
        description=(
            "Open an HR support ticket on the requesting user's behalf. WRITE/AUDITED action "
            "— only call after the user has clearly and explicitly asked you to raise a ticket; "
            "confirm the category and a short description in your reply first."
        ),
        input_schema=_obj_schema(
            {
                "category": {
                    "type": "string",
                    "description": "Ticket category: POLICY, SENSITIVE, ACTION, or OTHER.",
                },
                "description": {
                    "type": "string",
                    "description": "A short description of the issue, in the user's words.",
                },
            },
            ["category", "description"],
        ),
        allowed_roles=_ALL_ROLES,
        write=True,
    ),
    AssistantToolDef(
        name="get_my_skill_profile",
        description=(
            "Get the requesting user's OWN skill profile (skills + proficiency). Employee "
            "self-service; never returns another person's data."
        ),
        input_schema=_obj_schema(),
        allowed_roles=_ALL_ROLES,
    ),
    AssistantToolDef(
        name="get_skill_gap",
        description=(
            "Compute the requesting user's skill gap toward a target role: which required "
            "skills they are missing and how many steps away they are."
        ),
        input_schema=_obj_schema(
            {
                "targetRoleId": {
                    "type": "string",
                    "description": "The target role to measure the gap against — its id, or the role title.",
                }
            },
            ["targetRoleId"],
        ),
        allowed_roles=_ALL_ROLES,
    ),
    AssistantToolDef(
        name="recommended_roles",
        description=(
            "List internal roles recommended for the requesting user (internal mobility), "
            "with a skill-match score and the gap skills for each."
        ),
        input_schema=_obj_schema(),
        allowed_roles=_ALL_ROLES,
    ),
    AssistantToolDef(
        name="list_my_tasks",
        description="List the requesting user's own open HR/workflow tasks.",
        input_schema=_obj_schema(),
        allowed_roles=_ALL_ROLES,
    ),
    # ── Recruiter + People (RECRUITER / HRBP / ADMIN) ─────────────────────────
    AssistantToolDef(
        name="rank_candidates",
        description=(
            "Return the latest Module 1 ranking shortlist for a job opening: each candidate's "
            "tier + a short AI summary. Reads existing rankings; returns an empty list if the "
            "applicants have not been scored yet (it does not trigger scoring)."
        ),
        input_schema=_obj_schema(
            {
                "jobId": {
                    "type": "string",
                    "description": "The job opening to rank candidates for — its id, or the job title.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max candidates to return (optional).",
                },
            },
            ["jobId"],
        ),
        allowed_roles=_RECRUITER_PEOPLE,
    ),
    AssistantToolDef(
        name="draft_jd",
        description=(
            "Draft an inclusive, tone-matched job description for a role from a title + brief. "
            "Advisory draft for a human to review."
        ),
        input_schema=_obj_schema(
            {
                "roleTitle": {"type": "string"},
                "brief": {
                    "type": "string",
                    "description": "Team context / seniority / hiring-manager notes.",
                },
            },
            ["roleTitle"],
        ),
        allowed_roles=_RECRUITER_PEOPLE,
    ),
    AssistantToolDef(
        name="generate_outreach",
        description=(
            "Generate a personalised candidate outreach email for a job. WRITE/AUDITED action "
            "— only call after the user has explicitly asked you to draft/send outreach to a "
            "specific candidate; confirm the candidate and role in your reply first."
        ),
        input_schema=_obj_schema(
            {
                "candidateId": {
                    "type": "string",
                    "description": "The candidate — its id (e.g. from rank_candidates), or an unambiguous full name.",
                },
                "jobId": {"type": "string", "description": "The job opening — its id, or the job title."},
                "tone": {
                    "type": "string",
                    "description": "Optional tone: WARM, FORMAL, or BRIEF.",
                },
            },
            ["candidateId", "jobId"],
        ),
        allowed_roles=_RECRUITER_PEOPLE,
        write=True,
    ),
    AssistantToolDef(
        name="find_internal_candidates",
        description=(
            "Find internal employees who match an open role (internal mobility, recruiter/HR "
            "view), with match scores and gap analysis."
        ),
        input_schema=_obj_schema(
            {
                "roleId": {
                    "type": "string",
                    "description": "The internal role to match against — its id, or the role title.",
                }
            },
            ["roleId"],
        ),
        allowed_roles=_RECRUITER_PEOPLE,
    ),
    # ── Manager + People (MANAGER / HRBP / ADMIN) ─────────────────────────────
    AssistantToolDef(
        name="get_employee_attrition",
        description=(
            "Get an attrition read for one of YOUR OWN reports (manager view): risk TIER + a "
            "recommendation only — never the raw score or the underlying feature values. The "
            "server enforces that you may only see your own reports."
        ),
        input_schema=_obj_schema(
            {"employeeId": {"type": "string", "description": "An employee who reports to you."}},
            ["employeeId"],
        ),
        allowed_roles=_MANAGER_PEOPLE,
    ),
    AssistantToolDef(
        name="get_team_skill_map",
        description=(
            "Get the skill map for your team (manager view): which skills your reports hold and "
            "where the bench is thin."
        ),
        input_schema=_obj_schema(),
        allowed_roles=_MANAGER_PEOPLE,
    ),
    # ── HRBP / ADMIN only (org-wide analytics + governance + write) ───────────
    AssistantToolDef(
        name="get_analytics_dashboard",
        description=(
            "Get the workforce analytics dashboard metrics (headcount, recruiting funnel, "
            "retention) for the organisation."
        ),
        input_schema=_obj_schema(
            {
                "department": {"type": "string", "description": "Optional department filter."},
            }
        ),
        allowed_roles=_PEOPLE_ADMIN,
    ),
    AssistantToolDef(
        name="ask_workforce_data",
        description=(
            "Answer a natural-language analytics question over the workforce data "
            '(e.g. "how many engineers in Europe?"). Grounded only in the metrics.'
        ),
        input_schema=_obj_schema(
            {"query": {"type": "string", "description": "The natural-language data question."}},
            ["query"],
        ),
        allowed_roles=_PEOPLE_ADMIN,
    ),
    AssistantToolDef(
        name="get_attrition_summary",
        description=(
            "Get the AGGREGATE org-wide attrition-risk summary (HR view): a count of "
            "employees in each risk tier (CRITICAL/HIGH/MEDIUM/LOW). HRBP/ADMIN only — "
            "managers use get_employee_attrition for their own reports instead."
        ),
        input_schema=_obj_schema(),
        allowed_roles=_PEOPLE_ADMIN,
    ),
    AssistantToolDef(
        name="get_succession",
        description=(
            "Get succession candidates for a senior/critical role: the top internal successors "
            "with a readiness read."
        ),
        input_schema=_obj_schema(
            {
                "roleId": {
                    "type": "string",
                    "description": "The role to plan succession for — its id, or the role title.",
                }
            },
            ["roleId"],
        ),
        allowed_roles=_PEOPLE_ADMIN,
    ),
    AssistantToolDef(
        name="get_skill_inventory",
        description=(
            "Get the org-wide skill inventory: skill supply vs demand and concentration "
            "(bus-factor) risks."
        ),
        input_schema=_obj_schema(),
        allowed_roles=_PEOPLE_ADMIN,
    ),
    AssistantToolDef(
        name="draft_workflow",
        description=(
            "Draft a runnable HR workflow from a free-text description (advisory; a human "
            "reviews + saves it). Does NOT start anything."
        ),
        input_schema=_obj_schema(
            {"description": {"type": "string", "description": "What the workflow should do."}},
            ["description"],
        ),
        allowed_roles=_PEOPLE_ADMIN,
    ),
    AssistantToolDef(
        name="start_workflow",
        description=(
            "Start a saved HR workflow run. WRITE/AUDITED action — only call after the user has "
            "explicitly asked to start the named workflow; confirm which workflow in your reply "
            "first."
        ),
        input_schema=_obj_schema(
            {
                "workflowName": {"type": "string"},
                "params": {
                    "type": "object",
                    "description": "Optional workflow parameters.",
                    "additionalProperties": True,
                },
            },
            ["workflowName"],
        ),
        allowed_roles=_PEOPLE_ADMIN,
        write=True,
    ),
)

# Name -> def index (built once). Fail fast on a duplicate name in the registry.
_BY_NAME: dict[str, AssistantToolDef] = {}
for _t in _REGISTRY:
    if _t.name in _BY_NAME:
        raise ValueError(f"Duplicate tool name in registry: {_t.name}")
    _BY_NAME[_t.name] = _t


def all_tools() -> tuple[AssistantToolDef, ...]:
    """The full registry (every role's tools). Mostly for tests/introspection."""
    return _REGISTRY


def tool_def(name: str) -> AssistantToolDef | None:
    """Look up a tool definition by name (None if unknown)."""
    return _BY_NAME.get(name)


def tools_for_role(role: str) -> list[AssistantToolDef]:
    """Return the tool defs a given role may use (the role FILTER).

    The model only ever SEES these — it cannot select a tool outside its role. This is the
    first line of defence; the Node dispatcher independently re-enforces the same gate from
    the trusted context, so a bug here can never grant unauthorised access (it would just
    surface the tool, which the dispatcher then refuses with ok:false).
    """
    return [t for t in _REGISTRY if role in t.allowed_roles]


def anthropic_tools_for_role(role: str) -> list[dict[str, object]]:
    """The Anthropic ``tools`` list (name + description + input_schema) for a role."""
    return [t.anthropic_schema() for t in tools_for_role(role)]


def write_tool_names() -> frozenset[str]:
    """Names of the AUDITED write/action tools (confirm-intent-before-call)."""
    return frozenset(t.name for t in _REGISTRY if t.write)


def _sanitise_args(args: dict[str, object]) -> dict[str, object]:
    """Drop any identity keys a (prompt-injected) model tried to smuggle into args.

    orgId/userId/role come ONLY from the trusted AssistantContext. The AUTHORITATIVE
    guarantee is the Node dispatcher, which reads identity exclusively from `context` and
    never inspects `args`; this strip is defence-in-depth so identity variants never even
    leave the agent. Matching is case/separator-insensitive (org_id, Role, ORGID, …).
    """
    cleaned = {k: v for k, v in args.items() if not _is_identity_key(k)}
    if len(cleaned) != len(args):
        dropped = sorted(set(args) - set(cleaned))
        log.warning("assistant_tool_args_identity_stripped", dropped=dropped)
    return cleaned


# ── Internal API callback ─────────────────────────────────────────────────────
async def _post_tool_invoke(
    payload: dict[str, object],
    settings: Settings,
) -> dict[str, object]:
    """POST a ToolInvokeRequest to /internal/assistant/tool with the service-secret header."""
    if not settings.ai_service_secret:
        raise ToolUnavailable(
            "ai_service_secret is not configured — cannot call the internal assistant dispatcher."
        )

    import httpx

    url = f"{settings.peopleos_api_url.rstrip('/')}/internal/assistant/tool"
    headers = {
        "x-internal-secret": settings.ai_service_secret,
        "content-type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout_seconds) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise ToolError(
            f"Internal assistant dispatcher returned {exc.response.status_code}"
        ) from exc
    except ToolUnavailable:
        raise
    except Exception as exc:  # transport / JSON / unexpected
        raise ToolUnavailable(f"Internal assistant dispatcher call failed: {exc}") from exc
    if not isinstance(data, dict):
        raise ToolError("Internal assistant dispatcher returned a non-object response")
    return data


async def dispatch(
    tool: str,
    args: dict[str, object],
    context: AssistantContext,
    *,
    settings: Settings | None = None,
) -> ToolResult:
    """Dispatch one tool to the Node API's /internal/assistant/tool endpoint.

    ``context`` is the TRUSTED AssistantContext from the request — it is attached
    PROGRAMMATICALLY and is the ONLY source of orgId/userId/role. ``args`` are sanitised of
    any identity keys before sending. The dispatcher re-derives the role allowlist + re-runs
    each module's governance; a disallowed/failed tool comes back as ok:false. Any error
    (no secret, transport, non-2xx, bad body) degrades to a failed ToolResult so the ReAct
    loop can record it and continue — never crash.
    """
    settings = settings or get_settings()

    # Agent-side pre-filter (defence in depth): if the role can't use this tool, don't even
    # call the API. The dispatcher would refuse it anyway; this keeps the trace honest.
    definition = _BY_NAME.get(tool)
    if definition is None:
        return ToolResult(ok=False, summary=f"Unknown tool: {tool}")
    if context.role not in definition.allowed_roles:
        log.warning(
            "assistant_tool_role_blocked",
            tool=tool,
            role=context.role,
        )
        return ToolResult(
            ok=False,
            summary=f"Tool {tool} is not permitted for role {context.role}.",
        )

    payload: dict[str, object] = {
        "tool": tool,
        "args": _sanitise_args(args),
        # Identity is attached from the trusted request context, NEVER from the model.
        "context": context.model_dump(mode="json"),
    }

    try:
        raw = await _post_tool_invoke(payload, settings)
        parsed = ToolInvokeResponse.model_validate(raw)
    except ToolUnavailable as exc:
        return ToolResult(ok=False, summary=f"Tool unavailable: {exc}")
    except ToolError as exc:
        return ToolResult(ok=False, summary=f"Tool error: {exc}")
    except Exception as exc:  # validation / unexpected
        log.warning("assistant_tool_dispatch_failed", tool=tool, error=str(exc))
        return ToolResult(ok=False, summary=f"Tool {tool} failed: {exc}")

    summary = parsed.summary or (
        "Tool ran." if parsed.ok else (parsed.error or "Tool reported a failure.")
    )
    return ToolResult(ok=parsed.ok, summary=summary, data=parsed.data)
