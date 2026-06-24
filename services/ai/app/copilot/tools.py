"""Module 2c — Recruiter Chat agent tools.

Each tool is a typed wrapper the ReAct loop (chat_agent.py) can invoke. Three tools
CALL BACK to the PeopleOS Node API's internal copilot endpoints (the AI service has no
tenant DB access by design), three are AI-service-local:

  search_candidates(query, jobId?)   -> POST /internal/copilot/search-candidates
  get_pipeline_stats(jobId)          -> POST /internal/copilot/pipeline-stats
  get_candidate(candidateId)         -> POST /internal/copilot/candidate
  summarise_candidate(candidateId)   -> get_candidate + LLM summary (advisory)
  draft_email(candidateId, intent)   -> get_candidate + reuse the 2b outreach generator
  schedule_interview(...)            -> STUB (Phase 2: calendar integration)

The three callback tools POST to ``{settings.peopleos_api_url}/internal/copilot/...``
with the ``x-internal-secret: {settings.ai_service_secret}`` header (server-to-server
auth) and the ``orgId`` in the BODY. The orgId is supplied by the chat request — it is
NEVER taken from the model (a tenant-isolation guarantee: the LLM cannot cross orgs).
Responses are validated against the Tool*Response Pydantic models from schemas.py.

OFFLINE/UNCONFIGURED: when ``ai_service_secret`` is unset the callback tools raise
``ToolUnavailable`` (the agent records the tool as failed). Tests stub httpx to assert
the posted shape + secret header without a live API.
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.candidate_summary import (
    PROMPT_VERSION as CANDIDATE_SUMMARY_PROMPT_VERSION,
    build_candidate_summary_system_prompt,
    build_candidate_summary_user_prompt,
)
from ..schemas import (
    GenerateOutreachRequest,
    OrgContext,
    ToolCandidateResponse,
    ToolPipelineStats,
    ToolSearchCandidatesResponse,
)

log = structlog.get_logger(__name__)


class ToolUnavailable(RuntimeError):
    """Raised when a callback tool cannot run (no API URL/secret, or transport error)."""


class ToolError(RuntimeError):
    """Raised when the internal API returns a non-2xx or an unparseable response."""


@dataclass(slots=True)
class ToolResult:
    """Outcome of one tool invocation, surfaced into the agent's ChatToolInvocation."""

    ok: bool
    summary: str  # short, human-readable; NO raw data dumps (spec 2c)
    # Optional structured payload the agent may feed back to the model as observation.
    data: dict[str, object] | None = None


# ── Internal API callback helper ──────────────────────────────────────────────
async def _post_internal(
    path: str,
    body: dict[str, object],
    settings: Settings,
) -> dict[str, object]:
    """POST to an internal copilot endpoint with the service-secret header.

    ``path`` is the suffix after ``/internal/copilot/`` (e.g. "search-candidates").
    """
    if not settings.ai_service_secret:
        raise ToolUnavailable(
            "ai_service_secret is not configured — cannot call internal API endpoints."
        )

    import httpx

    url = f"{settings.peopleos_api_url.rstrip('/')}/internal/copilot/{path}"
    headers = {
        "x-internal-secret": settings.ai_service_secret,
        "content-type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=settings.tool_timeout_seconds) as client:
            resp = await client.post(url, json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise ToolError(f"Internal API {path} returned {exc.response.status_code}") from exc
    except Exception as exc:
        raise ToolUnavailable(f"Internal API {path} call failed: {exc}") from exc
    if not isinstance(data, dict):
        raise ToolError(f"Internal API {path} returned a non-object response")
    return data


# ── Callback tools (tenant-scoped by orgId from the request, never the model) ──
async def search_candidates(
    *,
    org_id: str,
    query: str,
    job_id: str | None,
    settings: Settings,
    limit: int = 10,
) -> ToolResult:
    """Search the org's candidate pool (POST /internal/copilot/search-candidates)."""
    body: dict[str, object] = {"orgId": org_id, "query": query, "limit": limit}
    if job_id:
        body["jobId"] = job_id
    raw = await _post_internal("search-candidates", body, settings)
    parsed = ToolSearchCandidatesResponse.model_validate(raw)
    n = len(parsed.candidates)
    names = ", ".join(c.name or c.candidateId for c in parsed.candidates[:5])
    summary = f"Found {n} candidate(s)." + (f" Top: {names}." if names else "")
    return ToolResult(ok=True, summary=summary, data=parsed.model_dump(mode="json"))


async def get_pipeline_stats(
    *,
    org_id: str,
    job_id: str,
    settings: Settings,
) -> ToolResult:
    """Pipeline stats for a job (POST /internal/copilot/pipeline-stats)."""
    body: dict[str, object] = {"orgId": org_id, "jobId": job_id}
    raw = await _post_internal("pipeline-stats", body, settings)
    parsed = ToolPipelineStats.model_validate(raw)
    stage_bits = ", ".join(f"{stage}: {n}" for stage, n in parsed.byStage.items())
    days = f"{parsed.daysOpen} days open" if parsed.daysOpen is not None else "open duration unknown"
    summary = f"{parsed.total} candidate(s) in pipeline ({days}). Stages: {stage_bits or 'n/a'}."
    return ToolResult(ok=True, summary=summary, data=parsed.model_dump(mode="json"))


async def get_candidate(
    *,
    org_id: str,
    candidate_id: str,
    settings: Settings,
) -> tuple[ToolResult, ToolCandidateResponse]:
    """Fetch a single candidate (POST /internal/copilot/candidate).

    Returns the ToolResult AND the parsed response so summarise/draft_email can reuse
    the profile without a second round-trip.
    """
    body: dict[str, object] = {"orgId": org_id, "candidateId": candidate_id}
    raw = await _post_internal("candidate", body, settings)
    parsed = ToolCandidateResponse.model_validate(raw)
    tier = parsed.latestTier or "unranked"
    summary = f"Loaded candidate {parsed.name or candidate_id} (latest tier: {tier})."
    return ToolResult(ok=True, summary=summary, data=parsed.model_dump(mode="json")), parsed


# ── AI-service-local tools ────────────────────────────────────────────────────
async def summarise_candidate(
    *,
    org_id: str,
    candidate_id: str,
    settings: Settings,
) -> ToolResult:
    """Fetch a candidate, then produce a short advisory LLM summary (no extra PII).

    Uses the profile already on the ToolCandidateResponse (no info beyond the profile),
    with a deterministic offline fallback when no LLM is available.
    """
    _result, candidate = await get_candidate(org_id=org_id, candidate_id=candidate_id, settings=settings)
    profile = candidate.profile
    if profile is None:
        return ToolResult(
            ok=True,
            summary=f"No structured profile is available for {candidate.name or candidate_id}.",
        )

    n_skills = len(profile.skills)
    top_skills = ", ".join(s.canonicalName for s in profile.skills[:5])
    n_exp = len(profile.experience)
    # XML-tagged prompt with >=2 few-shot examples (prompt standard #1), shared via the
    # app/prompts builder so the chat summary matches the other Copilot surfaces.
    system = build_candidate_summary_system_prompt()
    user = build_candidate_summary_user_prompt(profile.model_dump_json())
    try:
        text = await call_llm(
            LLMRequest(
                system=system,
                user=user,
                max_tokens=300,
                temperature=0.3,
                run_name="module2.summarise_candidate",
                tags=["module2", "chat", CANDIDATE_SUMMARY_PROMPT_VERSION],
            ),
            settings=settings,
        )
        return ToolResult(ok=True, summary=text.strip(), data={"candidateId": candidate_id})
    except LLMUnavailable:
        summary = (
            f"[OFFLINE] {candidate.name or candidate_id}: {n_exp} role(s), {n_skills} skill(s)"
            + (f" (top: {top_skills})" if top_skills else "")
            + "."
        )
        return ToolResult(ok=True, summary=summary, data={"candidateId": candidate_id})


async def draft_email(
    *,
    org_id: str,
    candidate_id: str,
    intent: str,
    job_id: str | None,
    settings: Settings,
) -> ToolResult:
    """Fetch a candidate and reuse the 2b outreach generator to draft an email.

    ``intent`` (e.g. "reject warmly", "invite to screen") is folded into the job
    summary context so the outreach copy reflects the recruiter's goal. Requires a
    job context: if no jobId is available the tool cannot ground the outreach and
    reports as failed.
    """
    if not job_id:
        return ToolResult(
            ok=False,
            summary="Cannot draft an email without a job context (jobId). Ask the recruiter which role.",
        )
    _result, candidate = await get_candidate(org_id=org_id, candidate_id=candidate_id, settings=settings)
    if candidate.profile is None:
        return ToolResult(
            ok=False,
            summary=f"No profile available for {candidate.name or candidate_id}; cannot draft outreach.",
        )

    # Deferred import to avoid a cycle (outreach.py imports inclusive_language only).
    from .outreach import generate_outreach

    outreach_req = GenerateOutreachRequest(
        orgId=org_id,
        jobId=job_id,
        candidateId=candidate_id,
        profile=candidate.profile,
        # The chat agent does not carry the job title; the outreach prompt grounds the
        # message on the candidate profile + intent. A neutral title avoids odd phrasing.
        jobTitle="this role",
        jobSummary=f"Recruiter intent for this message: {intent}.",
        recruiterName="the recruiter",
        orgContext=OrgContext(),
        # One concise variant is enough for an in-chat draft.
        tones=["WARM"],
    )
    result = await generate_outreach(outreach_req, settings=settings)
    variant = result.variants[0] if result.variants else None
    if variant is None:
        return ToolResult(ok=False, summary="Outreach generator produced no variant.")
    # Carry the outreach bias-check through the chat path too, so a chat-drafted email
    # has the same recorded bias signal as the direct /v1/copilot/outreach route.
    indicators = result.biasCheck.biasIndicatorsDetected
    bias_note = f" Bias check flagged: {', '.join(indicators)}." if indicators else ""
    summary = f'Drafted a {variant.tone.lower()} email (subject: "{variant.subject}").' + bias_note
    return ToolResult(
        ok=True,
        summary=summary,
        data={
            "subject": variant.subject,
            "body": variant.body,
            "tone": variant.tone,
            "intent": intent,
            "biasIndicatorsDetected": indicators,
        },
    )


async def schedule_interview(**kwargs: object) -> ToolResult:
    """STUB tool — calendar integration is a Phase 2 deliverable (spec Module 2c).

    The ReAct loop can SELECT this tool, but it always reports unavailable so the
    agent tells the recruiter the feature is not yet wired (rather than fabricating a
    booking).
    """
    # TODO(phase2): integrate Google Calendar / Microsoft Graph free/busy + draft invite.
    log.info("schedule_interview_stub_called", args=list(kwargs.keys()))
    return ToolResult(
        ok=False,
        summary="Calendar integration not yet available (planned for Phase 2).",
    )


# ── Anthropic tool-use schemas (the `tools` param passed to messages.create) ──
# camelCase parameter names match the internal contract. orgId/jobId from the chat
# request are injected by the agent loop, NOT requested from the model.
def tool_schemas(default_job_id: str | None) -> list[dict[str, object]]:
    """Return the Anthropic tool definitions for the recruiter chat agent.

    ``default_job_id`` (the pipeline the recruiter is viewing) is mentioned in the
    relevant tool descriptions so the model knows it may omit jobId to use the active
    context.
    """
    job_hint = (
        " If the recruiter is viewing a specific role you may omit this to use the "
        "active pipeline context."
        if default_job_id
        else ""
    )
    return [
        {
            "name": "search_candidates",
            "description": (
                "Search the organisation's candidate pool by a natural-language query. "
                "Returns lightweight candidate hits (id, name, headline, top skills)."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural-language search query."},
                    "jobId": {
                        "type": "string",
                        "description": "Optionally scope the search to a specific job." + job_hint,
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "get_pipeline_stats",
            "description": (
                "Get pipeline statistics for a job: total candidates, counts by stage, "
                "stage-to-stage conversion rates, and days open."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "jobId": {"type": "string", "description": "The job to report on." + job_hint},
                },
                "required": [] if default_job_id else ["jobId"],
            },
        },
        {
            "name": "get_candidate",
            "description": "Load a single candidate's structured profile and latest ranking tier.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "candidateId": {"type": "string"},
                },
                "required": ["candidateId"],
            },
        },
        {
            "name": "summarise_candidate",
            "description": "Produce a short advisory summary of a candidate's profile.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "candidateId": {"type": "string"},
                },
                "required": ["candidateId"],
            },
        },
        {
            "name": "draft_email",
            "description": (
                "Draft a personalised outreach email to a candidate for a given intent "
                '(e.g. "invite to screen", "reject warmly"). Requires a job context.'
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "candidateId": {"type": "string"},
                    "intent": {"type": "string", "description": "What the email should accomplish."},
                    "jobId": {"type": "string", "description": "The role the email concerns." + job_hint},
                },
                "required": ["candidateId", "intent"],
            },
        },
        {
            "name": "schedule_interview",
            "description": (
                "Schedule an interview. NOTE: calendar integration is not yet available "
                "(Phase 2) — this tool will report that it cannot complete the booking."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "candidateId": {"type": "string"},
                    "interviewerIds": {"type": "array", "items": {"type": "string"}},
                    "durationMinutes": {"type": "integer"},
                },
                "required": ["candidateId"],
            },
        },
    ]


async def dispatch_tool(
    *,
    name: str,
    tool_input: dict[str, object],
    org_id: str,
    default_job_id: str | None,
    settings: Settings | None = None,
) -> ToolResult:
    """Execute the named tool with org/job context injected from the REQUEST.

    Tenant isolation: ``org_id`` always comes from the chat request, never from the
    model's tool input. ``jobId`` falls back to the active pipeline context when the
    model omits it. Unknown tools / tool errors are returned as failed ToolResults so
    the loop can continue (and report the failure) rather than crash.
    """
    settings = settings or get_settings()
    job_id = (tool_input.get("jobId") if isinstance(tool_input.get("jobId"), str) else None) or default_job_id

    try:
        if name == "search_candidates":
            query = str(tool_input.get("query", "")).strip()
            if not query:
                return ToolResult(ok=False, summary="search_candidates requires a non-empty query.")
            return await search_candidates(
                org_id=org_id, query=query, job_id=job_id, settings=settings
            )
        if name == "get_pipeline_stats":
            if not job_id:
                return ToolResult(ok=False, summary="get_pipeline_stats requires a jobId.")
            return await get_pipeline_stats(org_id=org_id, job_id=job_id, settings=settings)
        if name == "get_candidate":
            candidate_id = str(tool_input.get("candidateId", "")).strip()
            if not candidate_id:
                return ToolResult(ok=False, summary="get_candidate requires a candidateId.")
            result, _candidate = await get_candidate(
                org_id=org_id, candidate_id=candidate_id, settings=settings
            )
            return result
        if name == "summarise_candidate":
            candidate_id = str(tool_input.get("candidateId", "")).strip()
            if not candidate_id:
                return ToolResult(ok=False, summary="summarise_candidate requires a candidateId.")
            return await summarise_candidate(
                org_id=org_id, candidate_id=candidate_id, settings=settings
            )
        if name == "draft_email":
            candidate_id = str(tool_input.get("candidateId", "")).strip()
            intent = str(tool_input.get("intent", "")).strip()
            if not candidate_id or not intent:
                return ToolResult(ok=False, summary="draft_email requires candidateId and intent.")
            return await draft_email(
                org_id=org_id,
                candidate_id=candidate_id,
                intent=intent,
                job_id=job_id,
                settings=settings,
            )
        if name == "schedule_interview":
            return await schedule_interview(**tool_input)
        return ToolResult(ok=False, summary=f"Unknown tool: {name}")
    except ToolUnavailable as exc:
        return ToolResult(ok=False, summary=f"Tool unavailable: {exc}")
    except ToolError as exc:
        return ToolResult(ok=False, summary=f"Tool error: {exc}")
    except Exception as exc:
        log.warning("tool_dispatch_failed", tool=name, error=str(exc))
        return ToolResult(ok=False, summary=f"Tool {name} failed: {exc}")
