import { z } from "zod";
import {
  AskDataRequest,
  AttritionEmployeeContext,
  DraftWorkflowRequest,
  DriverContribution,
  EmbedRequest,
  ExplainAttritionRequest,
  GenerateOutreachRequest,
  GrowthPathRequest,
  HrTicketCategory,
  ToolInvokeResponse,
  WriteJobDescriptionRequest,
  CandidateProfile,
  ChatAnswerRequest,
  type AssistantContext,
  type AssistantTool,
  type UserRole,
} from "@peopleos/schemas";
import { withTenant, type TxClient } from "../db.js";
import { aiClient } from "./aiClient.js";
import { writeAudit } from "./audit.js";
import { buildOrgContext } from "./orgContext.js";
import { retrieveChunks } from "./retrieval.js";
import { computeDashboard } from "./analytics.js";
import { countByTier, loadLatestScores } from "./attritionScores.js";
import {
  employeeSkillProfile,
  skillGap,
  skillInventory,
  teamSkillMap,
} from "./skillGraph.js";
import { internalCandidates, recommendedRoles, successionPlan } from "./mobilityMatch.js";
import { serializeWorkflowTask } from "./serialize.js";

/**
 * Module 10 — Agentic HR Assistant: the SERVER-SIDE tool registry + dispatcher.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SECURITY MODEL — read before touching anything here.
 *
 * This is the authoritative gate the AI service's ReAct loop calls back into. The
 * agent (an LLM) PROPOSES a tool + args; it is NEVER trusted to authorise itself.
 *
 *   1. IDENTITY is the trusted `AssistantContext` { orgId, userId, role } set by the
 *      API from the AUTHENTICATED session and relayed to the AI, which re-attaches it
 *      to every tool dispatch PROGRAMMATICALLY. The LLM never sees it, and the
 *      dispatcher IGNORES any orgId/userId/role that a (prompt-injected) agent might
 *      smuggle into `args` — they are read EXCLUSIVELY from `context`.
 *   2. A server-side ALLOWLIST (`TOOL_ROLES`) maps each tool → the roles permitted to
 *      run it (re-derived from context.role). A disallowed tool → ok:false / "forbidden"
 *      WITHOUT running anything — the agent's choice is advisory, not authoritative.
 *   3. The permitted tool runs inside withTenant(context.orgId) (RLS isolation) and
 *      RE-RUNS that module's OWN governance from context.role: a MANAGER gets the
 *      attrition TIER + recommendation for an OWN report only (never the raw score),
 *      flightRisk is ADMIN/HRBP-only, an EMPLOYEE only ever touches their OWN data, etc.
 *   4. WRITE tools (raise_hr_ticket, start_workflow, generate_outreach) are AUDITED
 *      here so an action always has its trail (the agent confirms intent before calling
 *      them; the dispatcher is the last line that records what actually ran).
 *
 * Every dispatch returns a ToolInvokeResponse with a SHORT, non-sensitive `summary`
 * (for the conversation trace) plus the structured `data` the agent reasons over.
 * Errors are CAUGHT and returned as ok:false so the ReAct loop never crashes.
 * ════════════════════════════════════════════════════════════════════════════
 */

const ALL_ROLES: readonly UserRole[] = ["ADMIN", "RECRUITER", "HRBP", "MANAGER", "EMPLOYEE"];
const PEOPLE_OPS: readonly UserRole[] = ["ADMIN", "HRBP"];
const RECRUITING: readonly UserRole[] = ["ADMIN", "HRBP", "RECRUITER"];
const MANAGER_OR_PEOPLE: readonly UserRole[] = ["ADMIN", "HRBP", "MANAGER"];

/**
 * THE AUTHORITATIVE per-tool role allowlist (the gate). Mirrors the role comments in
 * packages/schemas/src/assistant.ts AND each underlying module's route-level RBAC, so
 * the agent can never reach a capability the first-party route would refuse. This is
 * the SOLE source of truth for "may this role run this tool" — the agent's tool choice
 * is re-validated against it on every call.
 */
export const TOOL_ROLES: Record<AssistantTool, readonly UserRole[]> = {
  // All roles — self-service + policy Q&A.
  answer_policy_question: ALL_ROLES,
  raise_hr_ticket: ALL_ROLES,
  get_my_skill_profile: ALL_ROLES,
  get_skill_gap: ALL_ROLES,
  recommended_roles: ALL_ROLES,
  list_my_tasks: ALL_ROLES,
  // Recruiter + people-ops — sourcing / JD / outreach.
  rank_candidates: RECRUITING,
  draft_jd: RECRUITING,
  generate_outreach: RECRUITING,
  find_internal_candidates: RECRUITING,
  // Manager + people-ops — governed team views.
  get_employee_attrition: MANAGER_OR_PEOPLE,
  get_team_skill_map: MANAGER_OR_PEOPLE,
  // HRBP / ADMIN — org-wide analytics + workflow authoring.
  get_analytics_dashboard: PEOPLE_OPS,
  ask_workforce_data: PEOPLE_OPS,
  get_attrition_summary: PEOPLE_OPS,
  get_succession: PEOPLE_OPS,
  get_skill_inventory: PEOPLE_OPS,
  draft_workflow: PEOPLE_OPS,
  start_workflow: PEOPLE_OPS,
};

/** WRITE tools — audited; the agent must confirm intent before calling them. */
export const WRITE_TOOLS: ReadonlySet<AssistantTool> = new Set([
  "raise_hr_ticket",
  "start_workflow",
  "generate_outreach",
]);

/** A short, non-sensitive ok-summary helper. */
function ok(summary: string, data: unknown): z.infer<typeof ToolInvokeResponse> {
  return ToolInvokeResponse.parse({ ok: true, data, summary, error: null });
}
/** A short, non-sensitive failure helper (the loop continues; nothing leaked). */
function fail(summary: string, error: string): z.infer<typeof ToolInvokeResponse> {
  return ToolInvokeResponse.parse({ ok: false, data: null, summary, error });
}

/** Coerce one tool arg to a UUID, or null when absent/malformed (never throws). */
function uuidArg(args: Record<string, unknown>, key: string): string | null {
  const raw = args[key];
  if (typeof raw !== "string") return null;
  return z.string().uuid().safeParse(raw).success ? raw : null;
}
/** Coerce one tool arg to a trimmed non-empty string, or null. */
function strArg(args: Record<string, unknown>, key: string): string | null {
  const raw = args[key];
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}
/** Coerce one tool arg to a positive integer, or null (never throws). */
function intArg(args: Record<string, unknown>, key: string): number | null {
  const raw = args[key];
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  return null;
}

/**
 * Resolve a JobOpening id from a tool arg that may be EITHER a UUID or a role/job
 * TITLE. From a natural-language conversation the agent only ever knows a role by name —
 * there is no tool that hands it an opaque UUID — so, mirroring start_workflow's name
 * resolution (workflowName by key/name), we accept a title and look it up within the
 * tenant (case-insensitive; newest match wins). Returns null when neither a UUID nor a
 * matchable title is supplied. The lookup runs under withTenant, so RLS scopes it.
 */
async function resolveJobOpeningId(
  tx: TxClient,
  args: Record<string, unknown>,
  key: string,
): Promise<string | null> {
  const asUuid = uuidArg(args, key);
  if (asUuid) return asUuid;
  const asName = strArg(args, key);
  if (!asName) return null;
  const job = await tx.jobOpening.findFirst({
    where: { title: { equals: asName, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return job?.id ?? null;
}

/**
 * Resolve a Candidate id from a tool arg that may be a UUID or a candidate NAME. A UUID
 * (e.g. one the agent already has from a rank_candidates result) is taken as-is; a name
 * resolves ONLY when it is UNAMBIGUOUS within the tenant (exactly one match) — outreach
 * is an audited WRITE action, so we never guess between two people with the same name.
 * Returns `{ id }` on success, or `{ id: null, reason }` so the caller can explain.
 */
async function resolveCandidateId(
  tx: TxClient,
  args: Record<string, unknown>,
  key: string,
): Promise<{ id: string } | { id: null; reason: "ambiguous" | "not_found" }> {
  const asUuid = uuidArg(args, key);
  if (asUuid) return { id: asUuid };
  const asName = strArg(args, key);
  if (!asName) return { id: null, reason: "not_found" };
  const matches = await tx.candidate.findMany({
    where: { name: { equals: asName, mode: "insensitive" } },
    select: { id: true },
    take: 2,
  });
  const only = matches[0];
  if (matches.length === 1 && only) return { id: only.id };
  return { id: null, reason: matches.length > 1 ? "ambiguous" : "not_found" };
}

/**
 * Resolve the caller's OWN Employee.id from the TRUSTED context.userId. People-ops may
 * pass an explicit `employeeId` arg to act on someone else; everyone else is pinned to
 * their own record (the agent can never widen this — the gate is here, not the LLM).
 *
 * The context.userId is the INTERNAL User.id (the API set the context from the session;
 * for a Clerk session it already mapped the Clerk id → User.id before relaying). We
 * therefore resolve directly off Employee.userId, mirroring the route-level helpers.
 */
async function resolveSelfEmployeeId(tx: TxClient, userId: string): Promise<string | null> {
  // Employee.userId is not unique at the schema level; an explicit orderBy makes the
  // resolved "me" deterministic if a data slip ever produced two rows for one user
  // (this feeds a manager's own-report authorization check, so it must be stable).
  const me = await tx.employee.findFirst({
    where: { userId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return me?.id ?? null;
}

/**
 * Resolve the TARGET employee for a self-or-delegated tool. People-ops (ADMIN/HRBP) may
 * target any `employeeId`; everyone else is forced to their OWN employee record. Returns
 * null when no resolvable employee exists (→ the tool reports ok:false, never a crash).
 */
async function resolveTargetEmployeeId(
  tx: TxClient,
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<string | null> {
  const isPeopleOps = PEOPLE_OPS.includes(context.role);
  const requested = uuidArg(args, "employeeId");
  if (isPeopleOps && requested) return requested;
  return resolveSelfEmployeeId(tx, context.userId);
}

// ── Module 4 — answer_policy_question (RAG, grounded) ─────────────────────────
async function answerPolicyQuestion(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  const question = strArg(args, "question");
  if (!question) return fail("answer_policy_question needs a question.", "bad_request");

  const embedRes = await aiClient.embed(EmbedRequest.parse({ texts: [question] }));
  const queryEmbedding = embedRes.embeddings[0] ?? [];

  const { chunks, org } = await withTenant(context.orgId, async (tx) => {
    const retrieved = await retrieveChunks(tx, context.orgId, queryEmbedding, question, 5);
    const orgRow = await tx.organisation.findUnique({ where: { id: context.orgId } });
    return { chunks: retrieved, org: orgRow };
  });

  const answer = await aiClient.chatAnswer(
    ChatAnswerRequest.parse({
      orgId: context.orgId,
      query: question,
      history: [],
      candidateChunks: chunks,
      // employeeContext is omitted: the answer is grounded purely in the retrieved
      // policy chunks (non-PII). The contract makes it optional.
      orgContext: buildOrgContext(org, context.role),
    }),
  );
  const cited = answer.citations.length;
  return ok(
    `Answered from ${cited} policy citation(s)${answer.escalate ? " (recommends HR escalation)" : ""}.`,
    {
      answer: answer.answer,
      citations: answer.citations,
      escalate: answer.escalate,
      confidence: answer.confidence,
    },
  );
}

// ── Module 4 — raise_hr_ticket (WRITE, audited) ───────────────────────────────
async function raiseHrTicket(
  context: AssistantContext,
  args: Record<string, unknown>,
  ip: string | null,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  const description = strArg(args, "description");
  if (!description) {
    return fail("raise_hr_ticket needs a description.", "bad_request");
  }
  const categoryParse = HrTicketCategory.safeParse(args.category);
  const category = categoryParse.success ? categoryParse.data : "OTHER";

  // The agent-facing tool contract is { category, description } (see the AI tool
  // registry); `subject` is OPTIONAL here. When the agent does not supply one, derive a
  // short subject from the first line of the description so the NOT-NULL column is
  // satisfied without forcing the model to invent a separate subject field.
  const subjectSource = strArg(args, "subject") ?? description.split("\n")[0] ?? description;
  const subject = subjectSource.length > 200 ? `${subjectSource.slice(0, 197)}…` : subjectSource;

  const ticketId = await withTenant(context.orgId, async (tx) => {
    const ticket = await tx.hrTicket.create({
      data: {
        orgId: context.orgId,
        raisedById: context.userId,
        assigneeId: null,
        category,
        subject,
        description,
        status: "OPEN",
        sessionId: null,
      },
    });
    await writeAudit(tx, {
      actorId: context.userId,
      action: "assistant.hr_ticket.create",
      entityType: "hr_ticket",
      entityId: ticket.id,
      // Governance metadata only — never the (possibly sensitive) free-text body.
      payload: { category, via: "assistant", role: context.role },
      ip,
    });
    return ticket.id;
  });
  return ok(`Opened an HR ticket (${category}).`, { ticketId, category });
}

// ── Module 6 — get_my_skill_profile ───────────────────────────────────────────
async function getMySkillProfile(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    const employeeId = await resolveTargetEmployeeId(tx, context, args);
    if (!employeeId) return fail("No employee record is linked to this user.", "not_found");
    const profile = await employeeSkillProfile(tx, employeeId);
    return ok(`Loaded skill profile (${profile.skills.length} skill(s)).`, profile);
  });
}

// ── Module 6/8 — get_skill_gap (gap + AI growth path) ─────────────────────────
async function getSkillGap(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  const prepared = await withTenant(context.orgId, async (tx) => {
    const employeeId = await resolveTargetEmployeeId(tx, context, args);
    if (!employeeId) return { kind: "no_employee" as const };
    // The target role is a JobOpening; accept its id OR its title (the agent only knows
    // the role by name from the conversation).
    const targetRoleId = await resolveJobOpeningId(tx, args, "targetRoleId");
    if (!targetRoleId) return { kind: "no_role" as const };
    const gap = await skillGap(tx, employeeId, targetRoleId);
    const profile = await employeeSkillProfile(tx, employeeId);
    const catalog = await tx.skill.findMany({
      select: { canonicalName: true },
      orderBy: { canonicalName: "asc" },
    });
    const org = await tx.organisation.findUnique({ where: { id: context.orgId } });
    return {
      kind: "ok" as const,
      gap,
      employeeSkills: profile.skills.map((s) => ({ name: s.skillName, proficiency: s.proficiency })),
      skillCatalog: catalog.map((c) => c.canonicalName),
      org,
    };
  });
  if (prepared.kind === "no_employee") {
    return fail("No employee record is linked to this user.", "not_found");
  }
  if (prepared.kind === "no_role") {
    return fail("get_skill_gap needs a target role (its id or title).", "bad_request");
  }

  const growthPath = await aiClient.growthPath(
    GrowthPathRequest.parse({
      orgId: context.orgId,
      employeeSkills: prepared.employeeSkills,
      targetRoleTitle: prepared.gap.targetRoleTitle,
      targetRequiredSkills: prepared.gap.requiredSkills,
      skillCatalog: prepared.skillCatalog,
      orgContext: buildOrgContext(prepared.org, context.role),
    }),
  );
  return ok(
    `${prepared.gap.gapSize} skill(s) away from ${prepared.gap.targetRoleTitle}.`,
    { gap: prepared.gap, growthPath },
  );
}

// ── Module 8 — recommended_roles ──────────────────────────────────────────────
async function recommendedRolesTool(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    const employeeId = await resolveTargetEmployeeId(tx, context, args);
    if (!employeeId) return fail("No employee record is linked to this user.", "not_found");
    const result = await recommendedRoles(tx, employeeId);
    return ok(`Found ${result.roles.length} recommended internal role(s).`, result);
  });
}

// ── Module 9 — list_my_tasks (the caller's workflow inbox) ────────────────────
async function listMyTasks(
  context: AssistantContext,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    // The caller's OPEN inbox: tasks assigned directly to them OR to their role
    // (mirrors GET /workflow-tasks?mine=1). userId is the trusted internal User.id.
    const rows = await tx.workflowTask.findMany({
      where: {
        status: { in: ["PENDING", "IN_PROGRESS", "OVERDUE", "ESCALATED"] },
        OR: [{ assigneeId: context.userId }, { assigneeRole: context.role }],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const items = rows.map(serializeWorkflowTask);
    return ok(`You have ${items.length} open task(s).`, { items });
  });
}

// ── Modules 1/2 — rank_candidates ─────────────────────────────────────────────
async function rankCandidates(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    // Accept the job by id OR title (the agent knows the role by name from the chat).
    const jobId = await resolveJobOpeningId(tx, args, "jobId");
    if (!jobId) return fail("rank_candidates needs a job (its id or title).", "bad_request");
    const job = await tx.jobOpening.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!job) return fail(`Job not found.`, "not_found");

    // The latest ranking per applicant for this job (Module 1 output, already scored).
    // aiSummary/strengths/concerns ARE the per-candidate summary the tool advertises;
    // `reasoning` (the CoT column) is deliberately NOT selected — it is audit-only.
    const rankings = await tx.candidateRanking.findMany({
      where: { jobId },
      orderBy: { scoredAt: "desc" },
      select: {
        candidateId: true,
        tier: true,
        finalScore: true,
        aiSummary: true,
        strengths: true,
        concerns: true,
        scoredAt: true,
        candidate: { select: { name: true } },
      },
    });
    // One current ranking per candidate (newest wins).
    const seen = new Set<string>();
    const ranked: Array<{
      candidateId: string;
      name: string | null;
      tier: string;
      finalScore: number;
      aiSummary: string;
      strengths: string[];
      concerns: string[];
    }> = [];
    for (const r of rankings) {
      if (seen.has(r.candidateId)) continue;
      seen.add(r.candidateId);
      ranked.push({
        candidateId: r.candidateId,
        name: r.candidate.name,
        tier: r.tier,
        finalScore: r.finalScore,
        aiSummary: r.aiSummary,
        strengths: r.strengths,
        concerns: r.concerns,
      });
    }
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    // Honour the optional `limit` the tool declares.
    const limit = intArg(args, "limit");
    const candidates = limit != null ? ranked.slice(0, limit) : ranked;
    return ok(`Ranked ${candidates.length} candidate(s) for the role.`, { jobId, candidates });
  });
}

// ── Module 2a — draft_jd ──────────────────────────────────────────────────────
async function draftJd(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  const roleTitle = strArg(args, "roleTitle");
  if (!roleTitle) return fail("draft_jd needs a roleTitle.", "bad_request");
  // The AI tool passes a free-text `brief` (team context / seniority / HM notes); it
  // flows into the JD writer's hiringManagerNotes (the prompt grounds the draft on it).
  const brief = strArg(args, "brief");

  const { org, priorJdExamples } = await withTenant(context.orgId, async (tx) => {
    const orgRow = await tx.organisation.findUnique({ where: { id: context.orgId } });
    const jobs = await tx.jobOpening.findMany({
      where: { jdText: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { jdText: true },
    });
    return {
      org: orgRow,
      priorJdExamples: jobs
        .map((j) => j.jdText)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
    };
  });

  const jd = await aiClient.writeJd(
    WriteJobDescriptionRequest.parse({
      orgId: context.orgId,
      roleTitle,
      seniority: null,
      department: null,
      teamContext: null,
      hiringManagerNotes: brief,
      orgContext: buildOrgContext(org, context.role),
      priorJdExamples,
    }),
  );
  return ok(`Drafted a JD for "${roleTitle}".`, jd);
}

// ── Module 2b — generate_outreach (WRITE, audited) ────────────────────────────
async function generateOutreach(
  context: AssistantContext,
  args: Record<string, unknown>,
  ip: string | null,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  // Optional tone — default WARM for an in-chat draft.
  const toneArg = z.enum(["WARM", "FORMAL", "BRIEF"]).safeParse(args.tone);
  const tone = toneArg.success ? toneArg.data : "WARM";

  const loaded = await withTenant(context.orgId, async (tx) => {
    // Accept job by id/title and candidate by id/unambiguous-name (the agent typically
    // has a candidateId from a prior rank_candidates result; a bare name resolves only
    // when it is unique — outreach is an audited WRITE, so we never guess between people).
    const jobId = await resolveJobOpeningId(tx, args, "jobId");
    if (!jobId) return { kind: "bad" as const, msg: "generate_outreach needs a job (its id or title)." };
    const candidate = await resolveCandidateId(tx, args, "candidateId");
    if (candidate.id === null) {
      return {
        kind: "bad" as const,
        msg:
          candidate.reason === "ambiguous"
            ? "More than one candidate matches that name — specify the candidate id."
            : "generate_outreach needs a candidate (its id or an unambiguous full name).",
      };
    }
    const [cand, job, org] = await Promise.all([
      tx.candidate.findUnique({ where: { id: candidate.id } }),
      tx.jobOpening.findUnique({ where: { id: jobId } }),
      tx.organisation.findUnique({ where: { id: context.orgId } }),
    ]);
    if (!cand || !job) return { kind: "notfound" as const };
    return { kind: "ok" as const, candidate: cand, job, org };
  });
  if (loaded.kind === "bad") return fail(loaded.msg, "bad_request");
  if (loaded.kind === "notfound") return fail("Candidate or job not found in this org.", "not_found");
  if (loaded.candidate.profile == null) {
    return fail("Candidate has no parsed profile; cannot draft grounded outreach.", "bad_request");
  }

  const profile = CandidateProfile.parse(loaded.candidate.profile);
  const result = await aiClient.outreach(
    GenerateOutreachRequest.parse({
      orgId: context.orgId,
      jobId: loaded.job.id,
      candidateId: loaded.candidate.id,
      profile,
      jobTitle: loaded.job.title,
      jobSummary: null,
      recruiterName: "the hiring team",
      orgContext: buildOrgContext(loaded.org, context.role),
      tones: [tone],
    }),
  );

  await withTenant(context.orgId, async (tx) => {
    await writeAudit(tx, {
      actorId: context.userId,
      action: "assistant.outreach.generate",
      entityType: "candidate",
      entityId: loaded.candidate.id,
      payload: {
        candidateId: loaded.candidate.id,
        jobId: loaded.job.id,
        tones: result.variants.map((v) => v.tone),
        modelVersion: result.modelVersion,
        via: "assistant",
      },
      ip,
    });
  });
  const variant = result.variants[0];
  // The trace summary is persisted + rendered and is contracted as NON-sensitive, so it
  // must not contain the AI-generated subject (which embeds the candidate's name). The
  // subject/body live only in `data`, which is the model's working context, never the trace.
  return ok(
    variant ? `Drafted ${variant.tone.toLowerCase()} outreach for the candidate.` : "Drafted outreach.",
    {
      variants: result.variants,
      biasIndicatorsDetected: result.biasCheck.biasIndicatorsDetected,
    },
  );
}

// ── Module 8b — find_internal_candidates ──────────────────────────────────────
async function findInternalCandidates(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    const roleId = await resolveJobOpeningId(tx, args, "roleId");
    if (!roleId) return fail("find_internal_candidates needs a role (its id or title).", "bad_request");
    // GOVERNANCE: flight-risk TIER is surfaced ONLY to ADMIN/HRBP (Module 7 governance);
    // a RECRUITER gets the match but never the attrition signal.
    const includeFlightRisk = PEOPLE_OPS.includes(context.role);
    const result = await internalCandidates(tx, roleId, includeFlightRisk);
    return ok(`Found ${result.candidates.length} internal candidate(s) for the role.`, result);
  });
}

// ── Module 5 — get_analytics_dashboard ────────────────────────────────────────
async function getAnalyticsDashboard(
  context: AssistantContext,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    const metrics = await computeDashboard(tx, context.orgId);
    return ok("Computed the workforce analytics dashboard.", metrics);
  });
}

// ── Module 5e — ask_workforce_data (grounded NL over the metrics) ─────────────
async function askWorkforceData(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  // The AI tool schema names this `query`; accept `question` too for robustness.
  const question = strArg(args, "query") ?? strArg(args, "question");
  if (!question) return fail("ask_workforce_data needs a query.", "bad_request");
  const { metrics, org } = await withTenant(context.orgId, async (tx) => {
    const computed = await computeDashboard(tx, context.orgId);
    const orgRow = await tx.organisation.findUnique({ where: { id: context.orgId } });
    return { metrics: computed, org: orgRow };
  });
  const answer = await aiClient.askData(
    AskDataRequest.parse({
      orgId: context.orgId,
      question,
      metrics,
      orgContext: buildOrgContext(org, context.role),
    }),
  );
  return ok(`Answered from ${answer.usedMetrics.length} workforce metric(s).`, answer);
}

// ── Module 7 — get_attrition_summary (aggregate, leadership) ──────────────────
async function getAttritionSummary(
  context: AssistantContext,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    const latest = await loadLatestScores(tx);
    const scores = [...latest.values()];
    const byTier = countByTier(scores);
    const summary = byTier.map((b) => `${b.tier}: ${b.count}`).join(", ");
    return ok(`Attrition tiers — ${summary}.`, {
      byTier,
      scoredCount: scores.length,
      generatedAt: new Date().toISOString(),
    });
  });
}

// ── Module 7 — get_employee_attrition (GOVERNED per-employee view) ────────────
async function getEmployeeAttrition(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  const employeeId = uuidArg(args, "employeeId");
  if (!employeeId) return fail("get_employee_attrition needs an employeeId.", "bad_request");

  const isManager = context.role === "MANAGER";

  const loaded = await withTenant(context.orgId, async (tx) => {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        name: true,
        managerId: true,
        roleTitle: true,
        department: true,
        level: true,
        hireDate: true,
      },
    });
    if (!employee) return { kind: "not_found" as const };

    // GOVERNANCE (reused from routes/attrition.ts): a MANAGER may only see their OWN
    // direct reports. The acting manager's Employee is resolved from the TRUSTED
    // context.userId; the target must report to them.
    if (isManager) {
      const me = await tx.employee.findFirst({
        where: { userId: context.userId },
        select: { id: true },
      });
      if (!me || employee.managerId !== me.id) {
        return { kind: "forbidden" as const };
      }
    }

    const score = await tx.attritionScore.findFirst({
      where: { employeeId },
      orderBy: { scoredAt: "desc" },
    });
    const org = await tx.organisation.findUnique({ where: { id: context.orgId } });
    return { kind: "ok" as const, employee, score, org };
  });

  if (loaded.kind === "not_found") return fail(`Employee ${employeeId} not found.`, "not_found");
  if (loaded.kind === "forbidden") {
    return fail("A manager may only view attrition for their own direct reports.", "forbidden");
  }
  if (!loaded.score) {
    // Opted-out / never-scored are indistinguishable to a manager (privacy).
    return fail(`No current attrition score for employee ${employeeId}.`, "not_found");
  }

  const riskTier = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).parse(loaded.score.riskTier);
  const topDrivers = z.array(DriverContribution).parse(loaded.score.topDrivers);

  // AI explanation — grounded ONLY in the drivers + NON-PII context.
  const employeeContext = AttritionEmployeeContext.parse({
    tenureDays: loaded.employee.hireDate
      ? Math.max(0, Math.floor((Date.now() - loaded.employee.hireDate.getTime()) / 86_400_000))
      : 0,
    roleTitle: loaded.employee.roleTitle,
    department: loaded.employee.department,
    level: loaded.employee.level,
  });
  const explanation = await aiClient.explainAttrition(
    ExplainAttritionRequest.parse({
      orgId: context.orgId,
      riskTier,
      topDrivers,
      employeeContext,
      orgContext: buildOrgContext(loaded.org, context.role),
    }),
  );

  // ── MANAGER: TIER + recommendation ONLY (never the raw score / SHAP / drivers) ──
  if (isManager) {
    // Trace summary is persisted + rendered and must be NON-sensitive: it must not bind a
    // named individual to their attrition risk. The name+tier live in `data` only (the
    // model's working context), never in the trace.
    return ok(`Attrition read ready (${riskTier} risk tier).`, {
      employeeId: loaded.employee.id,
      employeeName: loaded.employee.name,
      riskTier,
      recommendedActions: explanation.recommendedActions,
      scoredAt: loaded.score.scoredAt.toISOString(),
    });
  }

  // ── ADMIN/HRBP: the FULL view ──────────────────────────────────────────────
  const shapValues = z.record(z.number()).parse(loaded.score.shapValues);
  // Non-sensitive trace summary (no name↔risk binding); the full data goes to `data`.
  return ok(`Attrition read ready (${riskTier} risk tier, full view).`, {
    employeeId: loaded.employee.id,
    employeeName: loaded.employee.name,
    riskScore: loaded.score.riskScore,
    riskTier,
    topDrivers,
    shapValues,
    narrative: explanation.narrative,
    recommendedActions: explanation.recommendedActions,
    scoredAt: loaded.score.scoredAt.toISOString(),
  });
}

// ── Module 6b — get_team_skill_map (manager's reports) ────────────────────────
async function getTeamSkillMap(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    // A MANAGER is pinned to THEIR OWN team (resolved from context.userId); people-ops
    // may pass an explicit managerId.
    let managerId: string | null = null;
    if (PEOPLE_OPS.includes(context.role)) {
      managerId = uuidArg(args, "managerId") ?? (await resolveSelfEmployeeId(tx, context.userId));
    } else {
      managerId = await resolveSelfEmployeeId(tx, context.userId);
    }
    if (!managerId) return fail("No employee record is linked to this user.", "not_found");
    const map = await teamSkillMap(tx, managerId);
    return ok(`Team skill map for ${map.members.length} report(s).`, map);
  });
}

// ── Module 8d — get_succession (leadership) ───────────────────────────────────
async function getSuccession(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    const roleId = await resolveJobOpeningId(tx, args, "roleId");
    if (!roleId) return fail("get_succession needs a role (its id or title).", "bad_request");
    const plan = await successionPlan(tx, roleId);
    return ok(`Succession plan: ${plan.successors.length} candidate(s) on the bench.`, plan);
  });
}

// ── Module 6c — get_skill_inventory (leadership) ──────────────────────────────
async function getSkillInventory(
  context: AssistantContext,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  return withTenant(context.orgId, async (tx) => {
    const inventory = await skillInventory(tx);
    return ok(`Skill inventory over ${inventory.items.length} skill(s).`, inventory);
  });
}

// ── Module 9 — draft_workflow (advisory; does NOT persist) ────────────────────
async function draftWorkflow(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  const description = strArg(args, "description");
  if (!description) return fail("draft_workflow needs a description.", "bad_request");
  const org = await withTenant(context.orgId, (tx) =>
    tx.organisation.findUnique({ where: { id: context.orgId } }),
  );
  const draft = await aiClient.draftWorkflow(
    DraftWorkflowRequest.parse({
      orgId: context.orgId,
      description,
      orgContext: buildOrgContext(org, context.role),
    }),
  );
  return ok(`Drafted a workflow with ${draft.steps.length} step(s) (advisory — not saved).`, draft);
}

// ── Module 9 — start_workflow (WRITE, audited) ────────────────────────────────
async function startWorkflow(
  context: AssistantContext,
  args: Record<string, unknown>,
  ip: string | null,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  // The AI tool names the workflow by `workflowName` (its key or display name) and
  // passes optional `params` (the seed context). We resolve it to an ACTIVE definition
  // server-side — a definitionId is never trusted from the agent.
  const workflowName = strArg(args, "workflowName");
  if (!workflowName) return fail("start_workflow needs a workflowName.", "bad_request");
  const rawParams = args.params;
  const seedContext: Record<string, unknown> =
    rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {};

  // Deferred import: the engine imports several libs; keep this off the hot path of
  // read-only tool dispatch and avoid an import cycle with serialize.ts.
  const { startInstance } = await import("./workflowEngine.js");

  const result = await withTenant(context.orgId, async (tx) => {
    // Match an ACTIVE definition by key OR name (newest wins on a name collision).
    const definition = await tx.workflowDefinition.findFirst({
      where: { active: true, OR: [{ key: workflowName }, { name: workflowName }] },
      orderBy: { createdAt: "desc" },
    });
    if (!definition) return { kind: "not_found" as const };

    const instance = await startInstance(tx, definition, {
      subjectType: null,
      subjectId: null,
      context: seedContext,
      createdById: context.userId,
    });
    await writeAudit(tx, {
      actorId: context.userId,
      action: "assistant.workflow.start",
      entityType: "workflow_instance",
      entityId: instance.id,
      payload: { definitionKey: definition.key, via: "assistant", role: context.role },
      ip,
    });
    return {
      kind: "ok" as const,
      instanceId: instance.id,
      status: instance.status,
      definitionKey: definition.key,
    };
  });

  if (result.kind === "not_found") {
    return fail(`No active workflow named "${workflowName}".`, "not_found");
  }
  return ok(`Started workflow "${result.definitionKey}" (${result.status}).`, {
    instanceId: result.instanceId,
    status: result.status,
  });
}

/**
 * Dispatch ONE tool. The caller (the internal route) has ALREADY enforced the role
 * allowlist; this routes the permitted tool to its module lib. All identity comes from
 * `context`; `args` carry only tool-specific params (the dispatcher reads no identity
 * from them). Any thrown error is caught and returned as ok:false so the loop survives.
 */
export async function dispatchAssistantTool(
  tool: AssistantTool,
  args: Record<string, unknown>,
  context: AssistantContext,
  ip: string | null,
): Promise<z.infer<typeof ToolInvokeResponse>> {
  try {
    switch (tool) {
      case "answer_policy_question":
        return await answerPolicyQuestion(context, args);
      case "raise_hr_ticket":
        return await raiseHrTicket(context, args, ip);
      case "get_my_skill_profile":
        return await getMySkillProfile(context, args);
      case "get_skill_gap":
        return await getSkillGap(context, args);
      case "recommended_roles":
        return await recommendedRolesTool(context, args);
      case "list_my_tasks":
        return await listMyTasks(context);
      case "rank_candidates":
        return await rankCandidates(context, args);
      case "draft_jd":
        return await draftJd(context, args);
      case "generate_outreach":
        return await generateOutreach(context, args, ip);
      case "find_internal_candidates":
        return await findInternalCandidates(context, args);
      case "get_analytics_dashboard":
        return await getAnalyticsDashboard(context);
      case "ask_workforce_data":
        return await askWorkforceData(context, args);
      case "get_attrition_summary":
        return await getAttritionSummary(context);
      case "get_employee_attrition":
        return await getEmployeeAttrition(context, args);
      case "get_team_skill_map":
        return await getTeamSkillMap(context, args);
      case "get_succession":
        return await getSuccession(context, args);
      case "get_skill_inventory":
        return await getSkillInventory(context);
      case "draft_workflow":
        return await draftWorkflow(context, args);
      case "start_workflow":
        return await startWorkflow(context, args, ip);
      default: {
        // Exhaustiveness: every AssistantTool above is handled.
        const _exhaustive: never = tool;
        return fail(`Unknown tool: ${String(_exhaustive)}`, "unknown_tool");
      }
    }
  } catch (err) {
    // Never let a tool failure crash the ReAct loop. The summary is non-sensitive.
    return fail(
      `Tool ${tool} failed.`,
      err instanceof Error ? err.message : "internal_error",
    );
  }
}

// Re-export the trusted-context + tool-name types so the internal route can use them
// without importing them from two places.
export type { AssistantContext, AssistantTool };
