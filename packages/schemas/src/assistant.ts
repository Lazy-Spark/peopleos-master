import { z } from "zod";
import { OrgContext } from "./ai.js";
import { IsoDateTime, OrgId, UserId, UserRole } from "./common.js";

/**
 * Module 10 — Agentic HR Assistant contracts.
 *
 * The capstone: an org-wide, ROLE-AWARE agent that orchestrates every module's capability
 * as a tool. A ReAct loop in the AI service calls the API's secret-authed
 * /internal/assistant/* dispatcher, which RE-ENFORCES tenancy + per-tool role governance
 * from the trusted session context (NEVER from the agent's tool arguments). The agent can
 * therefore never become a confused deputy. camelCase end-to-end; the AI-facing turn +
 * internal tool-invoke envelopes are mirrored as Pydantic.
 */

// ═══ Canonical tool vocabulary (the API dispatcher is the authoritative allowlist) ══
// Role gates (enforced server-side in the dispatcher, by context.role — not the agent):
//   all roles:        answer_policy_question, raise_hr_ticket, get_my_skill_profile,
//                     get_skill_gap, recommended_roles, list_my_tasks
//   recruiter+people: rank_candidates, draft_jd, generate_outreach, find_internal_candidates
//   manager+people:   get_employee_attrition (tier+rec for own reports), get_team_skill_map
//   HRBP/ADMIN:       get_analytics_dashboard, ask_workforce_data, get_attrition_summary,
//                     get_succession, get_skill_inventory, draft_workflow, start_workflow
export const AssistantTool = z.enum([
  "answer_policy_question",
  "raise_hr_ticket",
  "get_my_skill_profile",
  "get_skill_gap",
  "recommended_roles",
  "list_my_tasks",
  "rank_candidates",
  "draft_jd",
  "generate_outreach",
  "find_internal_candidates",
  "get_analytics_dashboard",
  "ask_workforce_data",
  "get_attrition_summary",
  "get_employee_attrition",
  "get_team_skill_map",
  "get_succession",
  "get_skill_inventory",
  "draft_workflow",
  "start_workflow",
]);
export type AssistantTool = z.infer<typeof AssistantTool>;

/** A SUMMARISED record of one tool the agent ran (never the raw, possibly-sensitive output). */
export const ToolCallTrace = z.object({
  tool: z.string(),
  ok: z.boolean(),
  summary: z.string(),
});
export type ToolCallTrace = z.infer<typeof ToolCallTrace>;

// ═══ Persisted conversation ══════════════════════════════════════════════════
export const AssistantMessageRole = z.enum(["USER", "ASSISTANT"]);
export type AssistantMessageRole = z.infer<typeof AssistantMessageRole>;

export const AssistantMessage = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: AssistantMessageRole,
  content: z.string(),
  toolCalls: z.array(ToolCallTrace),
  createdAt: IsoDateTime,
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const AssistantSession = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  userId: UserId.nullable(),
  title: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AssistantSession = z.infer<typeof AssistantSession>;

export const AssistantSessionSummary = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  updatedAt: IsoDateTime,
});
export type AssistantSessionSummary = z.infer<typeof AssistantSessionSummary>;

export const AssistantSessionDetail = AssistantSession.extend({
  messages: z.array(AssistantMessage),
});
export type AssistantSessionDetail = z.infer<typeof AssistantSessionDetail>;

// ═══ Public chat API ═════════════════════════════════════════════════════════
export const AssistantChatRequest = z.object({
  /** Continue an existing session, or omit to start a new one. */
  sessionId: z.string().uuid().optional(),
  message: z.string().min(1).max(8000),
});
export type AssistantChatRequest = z.infer<typeof AssistantChatRequest>;

export const AssistantChatResponse = z.object({
  sessionId: z.string().uuid(),
  reply: z.string(),
  toolCalls: z.array(ToolCallTrace),
  /** Role-aware next-step suggestions for the UI. */
  suggestedActions: z.array(z.string()),
});
export type AssistantChatResponse = z.infer<typeof AssistantChatResponse>;

// ═══ AI service: the turn ════════════════════════════════════════════════════
/**
 * The TRUSTED identity context. Set by the API from the authenticated session and relayed
 * to the AI service, which attaches it to EVERY internal tool call PROGRAMMATICALLY — the
 * LLM cannot read or alter it, and tool arguments can never override orgId/userId/role.
 */
export const AssistantContext = z.object({
  orgId: OrgId,
  userId: UserId,
  role: UserRole,
});
export type AssistantContext = z.infer<typeof AssistantContext>;

export const AssistantHistoryMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type AssistantHistoryMessage = z.infer<typeof AssistantHistoryMessage>;

export const AssistantChatAiRequest = z.object({
  message: z.string(),
  history: z.array(AssistantHistoryMessage),
  context: AssistantContext,
  orgContext: OrgContext.optional(),
});
export type AssistantChatAiRequest = z.infer<typeof AssistantChatAiRequest>;

export const AssistantChatAiResponse = z.object({
  reply: z.string(),
  toolCalls: z.array(ToolCallTrace),
  suggestedActions: z.array(z.string()),
});
export type AssistantChatAiResponse = z.infer<typeof AssistantChatAiResponse>;

// ═══ Internal tool dispatcher (AI service → API, secret-authed) ══════════════
/**
 * One tool invocation. `args` are ONLY the tool-specific parameters (jobId, employeeId, …);
 * orgId/userId/role come EXCLUSIVELY from `context` and the dispatcher must ignore any
 * identity fields a (prompt-injected) agent might smuggle into `args`.
 */
export const ToolInvokeRequest = z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
  context: AssistantContext,
});
export type ToolInvokeRequest = z.infer<typeof ToolInvokeRequest>;

export const ToolInvokeResponse = z.object({
  ok: z.boolean(),
  /** The tool result (tool-specific shape) when ok; null on error or empty. */
  data: z.unknown().nullable(),
  /** A short, non-sensitive summary of what ran (for the trace). */
  summary: z.string(),
  error: z.string().nullable(),
});
export type ToolInvokeResponse = z.infer<typeof ToolInvokeResponse>;
