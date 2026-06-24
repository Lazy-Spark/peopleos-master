import {
  AnalyticsNarrativeResponse,
  AnalyzeInterviewResponse,
  ApiError,
  Application,
  AttritionEmployeeView,
  AttritionSummary,
  AttritionBiasAuditResponse,
  ManagerAttritionView,
  RunScoringResponse,
  AskDataResponse,
  AskResponse,
  DashboardMetrics,
  Candidate,
  CandidateRanking,
  ChatSessionHistory,
  GeneratedJobDescription,
  HrTicket,
  IngestPolicyResponse,
  InterviewScorecard,
  InterviewSummary,
  JobOpening,
  OutreachResult,
  pageResponse,
  PanelCalibration,
  PipelineEntry,
  PolicyDocument,
  RankJobResponse,
  RecruiterChatResponse,
  BuildVsBuyResponse,
  EmployeeSkillProfile,
  GrowthPathResponse,
  Skill,
  SkillGapReport,
  SkillInventory,
  SkillRecordView,
  TeamSkillMap,
  WhoHasSkillResult,
  type AddEmployeeSkillRequest as AddEmployeeSkillRequestT,
  type BuildVsBuyResponse as BuildVsBuyResponseT,
  type EmployeeSkillProfile as EmployeeSkillProfileT,
  type Skill as SkillT,
  type SkillInventory as SkillInventoryT,
  type SkillRecordView as SkillRecordViewT,
  type TeamSkillMap as TeamSkillMapT,
  type VerifySkillRequest as VerifySkillRequestT,
  type WhoHasSkillResult as WhoHasSkillResultT,
  type AnalyticsNarrativeResponse as AnalyticsNarrativeResponseT,
  type AnalyzeInterviewResponse as AnalyzeInterviewResponseT,
  type Application as ApplicationT,
  type AskDataApiRequest as AskDataApiRequestT,
  type AskDataResponse as AskDataResponseT,
  type ApplicationId as ApplicationIdT,
  type ApplicationStage as ApplicationStageT,
  type AskRequest as AskRequestT,
  type AskResponse as AskResponseT,
  type DashboardMetrics as DashboardMetricsT,
  type Candidate as CandidateT,
  type CandidateRanking as CandidateRankingT,
  type ChatFeedback as ChatFeedbackT,
  type ChatSessionHistory as ChatSessionHistoryT,
  type ChatTurn as ChatTurnT,
  type GeneratedJobDescription as GeneratedJobDescriptionT,
  type HrTicket as HrTicketT,
  type IngestPolicyRequest as IngestPolicyRequestT,
  type IngestPolicyResponse as IngestPolicyResponseT,
  type InterviewScorecard as InterviewScorecardT,
  type InterviewSummary as InterviewSummaryT,
  type InterviewTranscript as InterviewTranscriptT,
  type JobOpening as JobOpeningT,
  type OutreachResult as OutreachResultT,
  type PanelCalibration as PanelCalibrationT,
  type PolicyDocType as PolicyDocTypeT,
  type PolicyDocument as PolicyDocumentT,
  type RankJobResponse as RankJobResponseT,
  type RecruiterChatResponse as RecruiterChatResponseT,
  type RoleLevel as RoleLevelT,
  type ScorecardRecommendation as ScorecardRecommendationT,
  type AttritionEmployeeView as AttritionEmployeeViewT,
  type AttritionSummary as AttritionSummaryT,
  type AttritionBiasAuditRequest as AttritionBiasAuditRequestT,
  type AttritionBiasAuditResponse as AttritionBiasAuditResponseT,
  type ManagerAttritionView as ManagerAttritionViewT,
  type RunScoringResponse as RunScoringResponseT,
  // Module 8 — Internal Talent Marketplace (mobility / succession / gigs).
  InternalApplication,
  InternalApplicationView,
  RecommendedRoles,
  RoleMatchResult,
  SuccessionPlan,
  MobilityAnalytics,
  Gig,
  RecommendedGigs,
  MobilityRecommendResponse,
  Readiness,
  type CreateInternalApplicationRequest as CreateInternalApplicationRequestT,
  type CreateGigRequest as CreateGigRequestT,
  type InternalAppStatus as InternalAppStatusT,
  type InternalApplication as InternalApplicationT,
  type InternalApplicationView as InternalApplicationViewT,
  type RecommendedRoles as RecommendedRolesT,
  type RoleMatchResult as RoleMatchResultT,
  type SuccessionPlan as SuccessionPlanT,
  type MobilityAnalytics as MobilityAnalyticsT,
  type Gig as GigT,
  type RecommendedGigs as RecommendedGigsT,
  // Module 9 — Workflow Automation Engine (templates / instances / human tasks).
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowTask,
  WorkflowMonitor,
  EmitEventResponse,
  DraftWorkflowResponse,
  type WorkflowDefinition as WorkflowDefinitionT,
  type WorkflowInstance as WorkflowInstanceT,
  type WorkflowInstanceDetail as WorkflowInstanceDetailT,
  type WorkflowTask as WorkflowTaskT,
  type WorkflowMonitor as WorkflowMonitorT,
  type StartWorkflowRequest as StartWorkflowRequestT,
  type CompleteTaskRequest as CompleteTaskRequestT,
  type EmitEventRequest as EmitEventRequestT,
  type EmitEventResponse as EmitEventResponseT,
  type DraftWorkflowResponse as DraftWorkflowResponseT,
  // Module 10 — Agentic HR Assistant (org-wide, role-aware orchestrator).
  AssistantChatResponse,
  AssistantSessionSummary,
  AssistantSessionDetail,
  type AssistantChatRequest as AssistantChatRequestT,
  type AssistantChatResponse as AssistantChatResponseT,
  type AssistantSessionSummary as AssistantSessionSummaryT,
  type AssistantSessionDetail as AssistantSessionDetailT,
} from "@peopleos/schemas";
import { z } from "zod";

/**
 * Typed fetch client for the PeopleOS Fastify API (`/api/v1`).
 *
 * - Types and runtime validation come from @peopleos/schemas — the single source
 *   of truth. We never redeclare wire shapes here.
 * - Base URL: NEXT_PUBLIC_API_URL (defaults to http://localhost:3001 for dev).
 * - In development we forward an `X-Org-Id` header so the API can set
 *   `app.current_org_id` for RLS without a full Clerk session. In production the
 *   org is derived server-side from the authenticated Clerk session, so this
 *   header is omitted.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Dev-only org override. Set NEXT_PUBLIC_DEV_ORG_ID locally (a seed org UUID)
 * to exercise tenant-scoped endpoints before Clerk-derived org resolution lands.
 */
// Header-based (non-Clerk) tenant selection. Set NEXT_PUBLIC_DEV_ORG_ID to a seed org
// UUID to drive tenant-scoped endpoints without a Clerk session — honoured even in a
// production build so a header-auth demo deployment works. The API only TRUSTS this
// header when IT runs with NODE_ENV != production (its dev fallback); a real Clerk
// deployment leaves NEXT_PUBLIC_DEV_ORG_ID unset and resolves the org from the session.
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID;

/** Error thrown for any non-2xx response; carries the parsed API error envelope. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Per-request org override (otherwise falls back to DEV_ORG_ID in dev). */
  orgId?: string;
  signal?: AbortSignal;
};

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };

  const orgId = opts.orgId ?? DEV_ORG_ID;
  if (orgId) headers["X-Org-Id"] = orgId;

  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    // The API is the auth/tenant boundary; do not cache tenant data in fetch.
    cache: "no-store",
  });

  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const parsed = ApiError.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiClientError(res.status, code, message, details);
    }
    throw new ApiClientError(
      res.status,
      "UNKNOWN",
      `Request to ${path} failed with status ${res.status}`,
      json,
    );
  }

  return schema.parse(json);
}

// ── Envelopes ────────────────────────────────────────────────────────────────
const JobPage = pageResponse(JobOpening);
const ApplicationPage = pageResponse(Application);
const PolicyPage = pageResponse(PolicyDocument);
const HrTicketPage = pageResponse(HrTicket);

/** Re-export the shared contract so existing `PipelineEntry` imports keep working. */
export type PipelineEntry = z.infer<typeof PipelineEntry>;

const PipelinePage = pageResponse(PipelineEntry);

/**
 * Module 6 — Skill graph envelopes (composed from frozen `@peopleos/schemas`
 * shapes; never redeclared field-by-field).
 */
const SkillListEnvelope = z.object({ items: z.array(Skill) });

/**
 * `GET /api/v1/employees/:id/skill-gap?targetRoleId=…` returns the API-computed
 * `SkillGapReport` (matched / missing / coverage) AND the AI `GrowthPathResponse`
 * (stepsAway + recommendedSkills + suggested training) in one envelope, mirroring
 * the spec's 6a "growth path" surface. The skill IDs of `gap` are reused by the AI.
 */
const SkillGapWithGrowth = z.object({
  gap: SkillGapReport,
  growthPath: GrowthPathResponse,
});
export type SkillGapWithGrowth = z.infer<typeof SkillGapWithGrowth>;

/**
 * Module 7 — `GET /api/v1/employees/:id/attrition` returns the ROLE-APPROPRIATE
 * shape: the FULL `AttritionEmployeeView` (raw score + SHAP + drivers) for
 * ADMIN / HRBP, or the redacted `ManagerAttritionView` (TIER + recommended
 * actions ONLY — no score, no SHAP, no feature values) for a MANAGER. The
 * governance boundary is enforced server-side; the client accepts either.
 *
 * The two views are distinguished structurally: only the full HR view carries
 * `riskScore`. We try the full view first, then fall back to the manager view,
 * so the client never has to send (or trust) a role hint to pick a parser.
 */
const AttritionView = z.union([AttritionEmployeeView, ManagerAttritionView]);
export type AttritionView = AttritionEmployeeViewT | ManagerAttritionViewT;

/**
 * Module 8 — Internal Talent Marketplace envelopes (composed from frozen
 * `@peopleos/schemas` shapes; never redeclared field-by-field). The org's
 * collection reads (internal applications, gigs) return the same `{ items: […] }`
 * envelope the Module 6 skill catalog uses, so the client unwraps `.items`.
 */
const InternalApplicationListEnvelope = z.object({
  items: z.array(InternalApplicationView),
});
const GigListEnvelope = z.object({ items: z.array(Gig) });

/**
 * Module 9 — Workflow Automation Engine envelopes (composed from frozen
 * `@peopleos/schemas` shapes; never redeclared field-by-field). The org's
 * collection reads (definitions, instances, my tasks) return the same
 * `{ items: [...] }` envelope the rest of the app uses, so the client unwraps
 * `.items` to the frozen array element type.
 */
const WorkflowDefinitionListEnvelope = z.object({
  items: z.array(WorkflowDefinition),
});
const WorkflowInstanceListEnvelope = z.object({
  items: z.array(WorkflowInstance),
});
const WorkflowTaskListEnvelope = z.object({ items: z.array(WorkflowTask) });

/**
 * Module 10 — Agentic HR Assistant. The caller's OWN session history list
 * (`GET /api/v1/assistant/sessions`) returns the same `{ items: [...] }`
 * envelope the rest of the app uses, so the client unwraps `.items` to the
 * frozen `AssistantSessionSummary` element type. Sessions are scoped to the
 * authenticated caller (userId) + org server-side; the client never sends a
 * userId or orgId — the API derives the trusted `AssistantContext` from the
 * session and relays it to the AI, which attaches it to every tool dispatch.
 */
const AssistantSessionListEnvelope = z.object({
  items: z.array(AssistantSessionSummary),
});

/**
 * Module 8 — `GET /api/v1/employees/:id/mobility-fit?jobOpeningId=…` returns the
 * skill-graph match facts for the (employee, role) pair AND the AI move
 * recommendation, mirroring routes/mobility.ts `MobilityFitResponse`.
 */
const MobilityFitResponse = z.object({
  jobOpeningId: z.string().uuid(),
  match: z.object({
    matchScore: z.number().min(0).max(1),
    readiness: Readiness,
    matchedSkills: z.array(z.string()),
    missingSkills: z.array(z.string()),
    gapSize: z.number().int().nonnegative(),
  }),
  recommendation: MobilityRecommendResponse,
});
export type MobilityFitResponse = z.infer<typeof MobilityFitResponse>;

/** Type guard: the full HR view exposes the raw `riskScore` (managers never do). */
export function isFullAttritionView(
  view: AttritionView,
): view is AttritionEmployeeViewT {
  return "riskScore" in view;
}

// ── Endpoints (REST, /api/v1, conventional resource paths) ───────────────────
export const api = {
  /** GET /api/v1/jobs — list job openings for the current org. */
  async listJobs(opts: { limit?: number; cursor?: string } = {}): Promise<JobOpeningT[]> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const page = await request(`/api/v1/jobs${suffix}`, JobPage);
    return page.items;
  },

  /** GET /api/v1/jobs/:id — a single job opening. */
  getJob(jobId: string): Promise<JobOpeningT> {
    return request(`/api/v1/jobs/${jobId}`, JobOpening);
  },

  /**
   * GET /api/v1/jobs/:id/applications — the candidate pipeline for a job.
   * Returns each application alongside its candidate for display.
   */
  async listJobApplications(jobId: string): Promise<PipelineEntry[]> {
    const page = await request(`/api/v1/jobs/${jobId}/applications`, PipelinePage);
    return page.items;
  },

  /** GET /api/v1/applications — flat application list (rarely used directly). */
  async listApplications(): Promise<ApplicationT[]> {
    const page = await request(`/api/v1/applications`, ApplicationPage);
    return page.items;
  },

  /** GET /api/v1/candidates/:id — a single candidate. */
  getCandidate(candidateId: string): Promise<CandidateT> {
    return request(`/api/v1/candidates/${candidateId}`, Candidate);
  },

  /**
   * POST /api/v1/applications/:id/rank — run Module 1 resume ranking.
   * Returns the full CandidateRanking (tier + summary + sub-scores).
   */
  rankApplication(applicationId: string): Promise<CandidateRankingT> {
    return request(`/api/v1/applications/${applicationId}/rank`, CandidateRanking, {
      method: "POST",
    });
  },

  /**
   * POST /api/v1/jobs/:id/rank — "Screen all" (Module 1 batch ranking).
   *
   * Screens the whole pipeline against the job and returns rankings already
   * sorted best-first, plus any candidates that were skipped (e.g. no parsed
   * profile yet). Chain-of-thought reasoning is audit-only and never present
   * on the wire — `RankJobResponse` has no reasoning field.
   *
   * @param stages Optional `ApplicationStage` filter (e.g. only re-screen
   *   `["APPLIED", "SCREENING"]`). Omit to screen the entire pipeline.
   */
  rankJob(jobId: string, stages?: ApplicationStageT[]): Promise<RankJobResponseT> {
    // The API reads `stages` from the QUERYSTRING (comma-separated), not the body.
    const qs = stages && stages.length > 0 ? `?stages=${stages.join(",")}` : "";
    return request(`/api/v1/jobs/${jobId}/rank${qs}`, RankJobResponse, {
      method: "POST",
    });
  },

  /** PATCH /api/v1/applications/:id/stage — advance/reject in the pipeline. */
  updateApplicationStage(
    applicationId: string,
    stage: ApplicationStageT,
  ): Promise<ApplicationT> {
    return request(`/api/v1/applications/${applicationId}/stage`, Application, {
      method: "PATCH",
      body: { stage },
    });
  },

  // ── Module 2 — Recruiter Copilot ───────────────────────────────────────────
  //
  // The frozen request contracts (WriteJobDescriptionRequest, GenerateOutreach-
  // Request, RecruiterChatRequest in @peopleos/schemas) carry fields the API
  // assembles server-side from authenticated, tenant-scoped state — `orgId`
  // (from the session, never the client), `priorJdExamples` (retrieved from the
  // org's vector store for tone-matched few-shot), the candidate `profile`, and
  // `orgContext`. The web client therefore sends only the recruiter-supplied
  // inputs; the API fills the rest before calling the Python AI service.
  // Responses are validated against the frozen output contracts.

  /**
   * POST /api/v1/copilot/jd — Module 2a JD Writer.
   *
   * Generates a full, inclusive job description (sections + assembled `jdText`)
   * plus an inclusive-language report (flagged phrase → suggestion, by category)
   * and a bias check. The API supplies `orgId`, `orgContext`, and the org's
   * `priorJdExamples` (few-shot) from the authenticated session — the client
   * sends only the recruiter's brief.
   */
  writeJd(input: WriteJdInput): Promise<GeneratedJobDescriptionT> {
    return request(`/api/v1/copilot/jd`, GeneratedJobDescription, {
      method: "POST",
      body: input,
    });
  },

  /**
   * POST /api/v1/applications/:id/outreach — Module 2b Outreach Generator.
   *
   * Generates personalised candidate outreach for one application: three tone
   * variants (warm / formal / brief), a LinkedIn InMail, and extra subject-line
   * options for A/B testing. The API resolves the application → candidate
   * profile + job context server-side; the client passes only the application id.
   * Bias note (per contract): outreach IS personalised to the real person, so the
   * profile is intentionally NOT masked here (unlike scoring).
   */
  outreach(applicationId: string): Promise<OutreachResultT> {
    return request(`/api/v1/applications/${applicationId}/outreach`, OutreachResult, {
      method: "POST",
    });
  },

  /**
   * POST /api/v1/copilot/chat — Module 2c Recruiter Chat Assistant.
   *
   * Sends the full conversation (+ the active `jobId` for pipeline context) to
   * the LangGraph ReAct agent and returns the assistant's answer plus a compact
   * tool trace (tool · ok · resultSummary). Non-streamed request/response. The
   * API derives `orgId` and the reviewing user's role from the session.
   */
  copilotChat(
    messages: ChatTurnT[],
    jobId?: string,
  ): Promise<RecruiterChatResponseT> {
    return request(`/api/v1/copilot/chat`, RecruiterChatResponse, {
      method: "POST",
      body: { messages, ...(jobId ? { jobId } : {}) },
    });
  },

  // ── Module 3 — Interview Intelligence & Summaries ──────────────────────────
  //
  // Privacy is central here. Interview transcripts are highly sensitive: stored
  // encrypted (S3 SSE-KMS), never in plaintext; candidate CONSENT is required
  // before any recording/processing; transcripts are retained per org policy
  // (default 90 days) then deleted, and deletion is supported on demand (DSAR).
  //
  // As elsewhere, the API is the tenant/auth boundary and fills server-side
  // state into the frozen request contracts: `orgId` (from the session, never
  // the client), the role's `scorecardTemplate`, and `orgContext`. The web
  // client sends only the reviewer-supplied inputs and the resource id; every
  // response is validated against the frozen output contract.

  /**
   * GET /api/v1/interviews/:id — the interview governance view (consent +
   * transcript status / retention), never the transcript itself. `InterviewSummary`.
   */
  getInterview(interviewId: string): Promise<InterviewSummaryT> {
    return request(`/api/v1/interviews/${interviewId}`, InterviewSummary);
  },

  /**
   * GET /api/v1/interviews/:id/scorecard — the persisted interview scorecard.
   *
   * Returns the AI scorecard draft (per-competency 1-5 score + evidence quote +
   * rationale), the 3-paragraph summary, the overall recommendation/confidence/
   * keyReasons, the stored calibration flags (leading/illegal questions), and
   * the reviewer's submitted scores (if any). Typed off `InterviewScorecard`.
   */
  getInterviewScorecard(interviewId: string): Promise<InterviewScorecardT> {
    return request(`/api/v1/interviews/${interviewId}/scorecard`, InterviewScorecard);
  },

  // NOTE: there is deliberately NO getInterviewTranscript. The raw transcript is
  // NEVER returned to the client (privacy contract) — the review UI surfaces only the
  // evidence quotes embedded in the AI scorecard draft (getInterviewScorecard).

  /**
   * POST /api/v1/interviews — create an interview for an application.
   *
   * `consentObtained` is a frozen `z.literal(true)`: the candidate's consent to
   * record + process is REQUIRED before any transcript work, so this call cannot
   * be made without it. The API resolves `orgId` from the session and returns the
   * privacy-safe Interview governance view (never the transcript).
   */
  createInterview(input: CreateInterviewInput): Promise<InterviewSummaryT> {
    return request(`/api/v1/interviews`, InterviewSummary, {
      method: "POST",
      body: { ...input, consentObtained: true as const },
    });
  },

  /**
   * POST /api/v1/interviews/:id/transcript — submit a transcript for analysis.
   *
   * Used for the manual-upload path (Zoom/Meet/Teams webhooks deliver audio to
   * the self-hosted WhisperX transcription service server-side). The transcript
   * is encrypted at rest; this returns the updated scorecard state.
   */
  submitTranscript(
    interviewId: string,
    transcript: InterviewTranscriptT,
  ): Promise<InterviewSummaryT> {
    // Body conforms to the frozen `SubmitTranscriptRequest` ({ transcript }). Returns
    // the governance view (the transcript itself is never echoed back).
    return request(`/api/v1/interviews/${interviewId}/transcript`, InterviewSummary, {
      method: "POST",
      body: { transcript },
    });
  },

  /**
   * POST /api/v1/interviews/:id/analyze — run the 4-step Module 3 analysis.
   *
   * Returns the AI scorecard draft, the per-answer competency/STAR evidence, and
   * the per-transcript calibration flags (leading/illegal questions). The API
   * supplies the role's `scorecardTemplate`, the stored `transcript`, the
   * `jobTitle`, and `orgContext` into the frozen `AnalyzeInterviewRequest`.
   * Every score is grounded in a verbatim transcript quote (prompt standard #2).
   */
  analyzeInterview(interviewId: string): Promise<AnalyzeInterviewResponseT> {
    return request(`/api/v1/interviews/${interviewId}/analyze`, AnalyzeInterviewResponse, {
      method: "POST",
    });
  },

  /**
   * POST /api/v1/interviews/:id/scorecard — submit the reviewer's final scores.
   *
   * The human-in-the-loop decision: the reviewer edits per-competency 1-5 scores
   * (with optional evidence) and the overall recommendation, then submits. Body
   * conforms to the frozen `SubmitScorecardRequest`. The AI draft is advisory;
   * the reviewer always decides. Returns the persisted `InterviewScorecard`.
   */
  submitScorecard(
    scorecardId: string,
    input: SubmitScorecardInput,
  ): Promise<InterviewScorecardT> {
    // Reviewer submission is keyed by the SCORECARD id (the AI draft row's id) and
    // POSTed to /scorecards/:id/submit — NOT by interview id.
    return request(`/api/v1/scorecards/${scorecardId}/submit`, InterviewScorecard, {
      method: "POST",
      body: input,
    });
  },

  /**
   * GET /api/v1/applications/:id/calibration — panel calibration for a candidate.
   *
   * Calibration (analyze step 4) is computed across the panel: API-computed
   * numeric score divergence (> 2 points on a competency → debrief needed) plus
   * the AI flags (leading/illegal questions) gathered across every interview.
   * Typed off the frozen `PanelCalibration`.
   */
  getCalibration(applicationId: string): Promise<PanelCalibrationT> {
    return request(`/api/v1/applications/${applicationId}/calibration`, PanelCalibration);
  },

  /**
   * DELETE /api/v1/interviews/:id/transcript — DSAR transcript deletion.
   *
   * Permanently deletes the encrypted transcript on candidate request or org
   * retention policy, AND clears the transcript-derived text (the AI scorecard
   * draft's verbatim evidence quotes + summary) so no excerpt survives. Returns the
   * updated Interview governance view reflecting the deleted state.
   */
  deleteTranscript(interviewId: string): Promise<InterviewSummaryT> {
    return request(`/api/v1/interviews/${interviewId}/transcript`, InterviewSummary, {
      method: "DELETE",
    });
  },

  // ── Module 4 — Employee HR Chatbot (RAG over company knowledge) ────────────
  //
  // The chatbot answers ONLY from retrieved policy chunks. The API owns the RAG
  // pipeline: it resolves `orgId` and the employee's non-PII `employeeContext`
  // (department / location / hire date) from the authenticated session, does
  // hybrid retrieval (dense + BM25, namespace=org:policies) + cross-encoder
  // re-rank, calls the Python AI service for grounded answer generation, and —
  // on low confidence or a sensitive topic (termination, harassment, salary
  // dispute) — escalates to a human by creating an HR ticket. The web client
  // sends only the employee's message + the running `sessionId`; every response
  // is validated against the frozen `@peopleos/schemas` contracts.

  /**
   * POST /api/v1/hr-chat/ask — ask the Employee HR Assistant a question.
   *
   * Body conforms to the frozen `AskRequest` ({ message, sessionId?, channel }).
   * Omit `sessionId` to start a new conversation; pass the returned id on every
   * subsequent turn to keep the 10-turn conversational memory window. Returns
   * the grounded `answer` with its `citations` (policy title + section +
   * effective date), the classified `intent`, and — when `escalated` — the id of
   * the HR ticket the API opened (`ticketId`). The channel defaults to "WEB".
   */
  askHrChat(input: AskHrChatInput): Promise<AskResponseT> {
    const body: AskRequestT = {
      message: input.message,
      sessionId: input.sessionId ?? null,
      channel: "WEB",
    };
    return request(`/api/v1/hr-chat/ask`, AskResponse, { method: "POST", body });
  },

  /**
   * GET /api/v1/hr-chat/sessions/:id — replay a chat session's history.
   *
   * Returns the persisted `ChatMessageRecord[]` (user + assistant turns, with
   * each assistant turn's citations and any thumbs feedback) for resuming a
   * conversation. Typed off the frozen `ChatSessionHistory`.
   */
  getChatSession(sessionId: string): Promise<ChatSessionHistoryT> {
    return request(`/api/v1/hr-chat/sessions/${sessionId}`, ChatSessionHistory);
  },

  /**
   * POST /api/v1/hr-chat/messages/:id/feedback — thumbs up/down on an answer.
   *
   * Records the employee's `ChatFeedback` ("positive" | "negative") on a single
   * assistant message (feeds answer-quality analytics + unresolved-query
   * clustering). Body conforms to the frozen `ChatFeedbackRequest`; the call is
   * fire-and-forget from the UI's perspective (no body returned).
   */
  async sendChatFeedback(messageId: string, feedback: ChatFeedbackT): Promise<void> {
    await request(`/api/v1/hr-chat/messages/${messageId}/feedback`, z.unknown(), {
      method: "POST",
      body: { feedback },
    });
  },

  /**
   * POST /api/v1/policies — ingest a company policy document (HRBP/ADMIN).
   *
   * Body is the frozen `IngestPolicyRequest`: exactly one of `rawText` (dev) or
   * `fileUrl` (prod). The API runs the Layer 2C document pipeline (structural
   * parsing → semantic chunking → embed + index → SimHash dedup/versioning) and
   * returns the persisted `PolicyDocument`, the `chunkCount` indexed, and —
   * when this upload superseded a prior version — `supersededDocumentId`.
   */
  ingestPolicy(input: IngestPolicyRequestT): Promise<IngestPolicyResponseT> {
    return request(`/api/v1/policies`, IngestPolicyResponse, {
      method: "POST",
      body: input,
    });
  },

  /** GET /api/v1/policies — list the org's policy documents (HRBP/ADMIN). */
  async listPolicies(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<PolicyDocumentT[]> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const page = await request(`/api/v1/policies${suffix}`, PolicyPage);
    return page.items;
  },

  /**
   * DELETE /api/v1/policies/:id — archive a policy document.
   *
   * Soft-archives the policy (status → ARCHIVED) and deactivates its indexed
   * chunks so the chatbot stops retrieving from it. Returns the updated
   * `PolicyDocument`.
   */
  deletePolicy(policyId: string): Promise<PolicyDocumentT> {
    return request(`/api/v1/policies/${policyId}`, PolicyDocument, {
      method: "DELETE",
    });
  },

  /** GET /api/v1/hr-tickets — list HR tickets (escalation targets) for the org. */
  async listHrTickets(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<HrTicketT[]> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const page = await request(`/api/v1/hr-tickets${suffix}`, HrTicketPage);
    return page.items;
  },

  // ── Module 5 — Workforce Analytics Dashboard ───────────────────────────────
  //
  // The API computes the entire `DashboardMetrics` snapshot from Postgres (prod:
  // scheduled DBT models in Snowflake) — every query is tenant-scoped server-side
  // (`orgId` from the authenticated session, never the client). The AI service
  // only NARRATES / ANSWERS over that supplied snapshot: it is grounded strictly
  // in the metrics, never invents numbers, and never generates SQL. Sections that
  // depend on not-yet-built modules (5c attrition → Module 7, 5d skill graph →
  // Module 6) degrade gracefully on the wire via `available: false` +
  // `pendingReason`; the UI renders a placeholder rather than erroring.

  /**
   * GET /api/v1/analytics/dashboard — the full Workforce Analytics snapshot.
   *
   * Returns `DashboardMetrics`: the recruiting funnel (5a), workforce composition
   * (5b), engagement & retention (5c, gated on Module 7), and skills & talent
   * density (5d, gated on Module 6). All metrics are API-computed from
   * tenant-scoped Postgres; the client only renders them.
   */
  getAnalyticsDashboard(): Promise<DashboardMetricsT> {
    return request(`/api/v1/analytics/dashboard`, DashboardMetrics);
  },

  /**
   * POST /api/v1/analytics/narrative — the weekly AI narrative (5e).
   *
   * The API takes the current `DashboardMetrics` snapshot, calls the Python AI
   * service (claude-sonnet-4-6), and returns the executive headline + 3-paragraph
   * narrative ("the 3 most important people metrics"), the surfaced `keyMetrics`,
   * and any `anomalies` (metric > 2σ from the org's own baseline, severity-tagged).
   * Grounded ONLY in the supplied metrics — no invented numbers.
   */
  getAnalyticsNarrative(): Promise<AnalyticsNarrativeResponseT> {
    // POST: the route is POST-only (the API computes the metrics snapshot server-side).
    return request(`/api/v1/analytics/narrative`, AnalyticsNarrativeResponse, { method: "POST" });
  },

  /**
   * POST /api/v1/analytics/ask — the "Ask your data" NL query interface (5e).
   *
   * The client sends only the natural-language `question` (the frozen
   * `AskDataApiRequest`); the API supplies the tenant-scoped `metrics` snapshot
   * and calls the AI service, which answers grounded ONLY in those metrics. The
   * response carries the `answer`, the `usedMetrics` keys it drew on
   * (transparency — no free SQL is ever generated), an optional `chart` spec
   * (BAR/LINE/PIE) to render, and a `confidence` level.
   */
  askAnalytics(question: string): Promise<AskDataResponseT> {
    const body: AskDataApiRequestT = { question };
    return request(`/api/v1/analytics/ask`, AskDataResponse, {
      method: "POST",
      body,
    });
  },

  // ── Module 6 — Employee Skill Graph ────────────────────────────────────────
  //
  // The skill graph is modelled relationally in Postgres (Neo4j is the documented
  // prod adapter); every graph query (who-has, gap, team map, inventory) is
  // computed in-API via Prisma joins and tenant-scoped server-side (`orgId` from
  // the authenticated session, never the client). Skill confidence is ALWAYS
  // derived from the source via `confidenceForSource` (self 0.5 / manager 0.8 /
  // assessment 0.9 / resume 0.6 / project 0.7) — never client-supplied. The web
  // client sends only the user-supplied inputs (the catalog skillId + proficiency
  // for a self-report; an optional proficiency adjustment on verify); every
  // response is validated against the frozen `@peopleos/schemas` contracts.

  /**
   * GET /api/v1/skills — the org's skill catalog (for the "add skill" picker).
   * Returns the `Skill[]` (canonical name + category + aliases).
   */
  async listSkills(): Promise<SkillT[]> {
    const env = await request(`/api/v1/skills`, SkillListEnvelope);
    return env.items;
  },

  /**
   * GET /api/v1/employees/:id/skills — an employee's skill profile (6a).
   *
   * Returns `EmployeeSkillProfile`: the employee's `SkillRecordView[]` (each with
   * its skill name + category + proficiency + the source-derived `confidenceScore`
   * + verification state), grouped client-side by category for display.
   */
  getEmployeeSkills(employeeId: string): Promise<EmployeeSkillProfileT> {
    return request(`/api/v1/employees/${employeeId}/skills`, EmployeeSkillProfile);
  },

  /**
   * POST /api/v1/employees/:id/skills — self-report a catalog skill (6a).
   *
   * Body is the frozen `AddEmployeeSkillRequest` ({ skillId, proficiency }) — the
   * employee picks an existing catalog skill and a proficiency. The API records it
   * with source SELF_REPORTED and confidence 0.5 (`confidenceForSource`); the
   * client never sends a confidence or source. Returns the updated profile so the
   * UI re-renders with the new record.
   */
  addEmployeeSkill(
    employeeId: string,
    input: AddEmployeeSkillRequestT,
  ): Promise<EmployeeSkillProfileT> {
    return request(`/api/v1/employees/${employeeId}/skills`, EmployeeSkillProfile, {
      method: "POST",
      body: input,
    });
  },

  /**
   * PATCH /api/v1/skill-records/:id/verify — manager verification (6d).
   *
   * Confirms a claimed skill record → source MANAGER_VERIFIED, confidence 0.8
   * (server-derived); the manager may adjust the proficiency via the optional
   * frozen `VerifySkillRequest` ({ proficiency? }). Restricted to ADMIN / HRBP /
   * MANAGER server-side. Returns the updated `SkillRecordView` (now verified).
   */
  verifySkill(
    recordId: string,
    input: VerifySkillRequestT = {},
  ): Promise<SkillRecordViewT> {
    return request(`/api/v1/skill-records/${recordId}/verify`, SkillRecordView, {
      method: "PATCH",
      body: input,
    });
  },

  /**
   * GET /api/v1/employees/:id/skill-gap?targetRoleId=… — gap + growth path (6a).
   *
   * Computes the `SkillGapReport` (the target role's required skills vs the
   * employee's skills: matched / missing / gapSize / coverage) AND the AI
   * `GrowthPathResponse` (stepsAway + recommendedSkills with why + suggested
   * training). The target role is a `JobOpening` (its `jdStructured.requiredSkills`
   * are the bar). Both are returned in one `{ gap, growthPath }` envelope.
   */
  getSkillGap(
    employeeId: string,
    targetRoleId: string,
  ): Promise<SkillGapWithGrowth> {
    const qs = `?targetRoleId=${encodeURIComponent(targetRoleId)}`;
    return request(
      `/api/v1/employees/${employeeId}/skill-gap${qs}`,
      SkillGapWithGrowth,
    );
  },

  /**
   * GET /api/v1/skills/team-map?managerId=… — the team skill heatmap (6b).
   *
   * Returns `TeamSkillMap`: each report's skills (proficiency + confidence) for the
   * members × skills grid, the `busFactor` skills (held by exactly one report), and
   * the `benchStrength` (skill → holder count). All API-computed via Prisma joins
   * over the manager's reports (Module 5 self-relation), tenant-scoped.
   */
  getTeamSkillMap(managerId: string): Promise<TeamSkillMapT> {
    return request(
      `/api/v1/skills/team-map?managerId=${encodeURIComponent(managerId)}`,
      TeamSkillMap,
    );
  },

  /**
   * GET /api/v1/skills/inventory — org-wide skill supply/demand/gap (6c).
   *
   * Returns `SkillInventory`: per-skill `supply` (# employees holding it) vs
   * `demand` (# open roles requiring it) with the computed `gap`, plus the
   * org `talentDensityIndex` (% meeting their role's bar; null if not derivable).
   * Leadership view (ADMIN / HRBP / MANAGER) server-side. The build-vs-buy recommendation
   * per gapped skill is fetched on demand via `recommendBuildVsBuy`.
   */
  getSkillInventory(): Promise<SkillInventoryT> {
    return request(`/api/v1/skills/inventory`, SkillInventory);
  },

  /**
   * GET /api/v1/skills/build-vs-buy?skillId=… — the AI build-vs-buy recommender (6c).
   *
   * For a gapped skill the API assembles the frozen `BuildVsBuyRequest` server-side
   * (current supply, demand, and how many employees are 1-2 skills away —
   * trainable internally — computed from the graph) and calls the AI service,
   * returning BUILD / BUY / HYBRID with a rationale. The client passes only the
   * skill id; the org context + counts are resolved server-side.
   */
  recommendBuildVsBuy(skillId: string): Promise<BuildVsBuyResponseT> {
    return request(
      `/api/v1/skills/build-vs-buy?skillId=${encodeURIComponent(skillId)}`,
      BuildVsBuyResponse,
    );
  },

  /**
   * GET /api/v1/skills/who-has/:id — "who in the org has skill X?" (graph query).
   *
   * Returns `WhoHasSkillResult`: the skill + its `holders[]` (employee + their
   * proficiency + source-derived confidence). Used to drill into a skill from the
   * inventory / heatmap. Tenant-scoped.
   */
  whoHasSkill(skillId: string): Promise<WhoHasSkillResultT> {
    return request(`/api/v1/skills/who-has/${skillId}`, WhoHasSkillResult);
  },

  // ── Module 7 — Attrition Prediction Engine ─────────────────────────────────
  //
  // GOVERNANCE IS CENTRAL. The risk score is ADVISORY ONLY — there is no
  // automated HR action endpoint here. The API is the governance boundary and
  // does it ALL server-side: it builds the `AttritionFeatures` per employee from
  // tenant-scoped data (NEVER a protected attribute), EXCLUDES opted-out
  // employees from scoring entirely, calls the Python AI scorer + LLM
  // explanation layer, and role-gates what comes back over the wire — managers
  // get the TIER + recommendation ONLY (no raw score / SHAP / feature values),
  // HR/admin get the full view, and the employee is NEVER shown the score. The
  // web client only triggers scoring, reads the role-appropriate views, records
  // an employee opt-out, and runs the monthly bias audit. Every response is
  // validated against the frozen `@peopleos/schemas` contracts.

  /**
   * POST /api/v1/attrition/score — run (or refresh) scoring for the org (HRBP/ADMIN).
   *
   * The API assembles the `ScoreAttritionRequest` server-side (features for every
   * non-opted-out employee), calls the AI scorer, persists the `AttritionScore`
   * rows, and returns the run summary: how many were scored, how many were
   * `skippedOptedOut` (the opt-out is honoured here), the resulting tier
   * distribution, the `modelVersion`, and `scoredAt`. No raw scores cross the
   * wire from this endpoint.
   */
  runAttritionScoring(): Promise<RunScoringResponseT> {
    return request(`/api/v1/attrition/score`, RunScoringResponse, {
      method: "POST",
    });
  },

  /**
   * GET /api/v1/attrition/summary — the org attrition overview (HRBP/ADMIN).
   *
   * Returns `AttritionSummary`: the tier distribution (`byTier`), the
   * department/level/team `heatmap` (severity by tier), the `regrettableCount`
   * (strong performers at high risk — the losses that hurt most), the
   * `scoredCount`, and the `optedOutCount` (employees excluded from profiling).
   * All API-computed and tenant-scoped.
   */
  getAttritionSummary(): Promise<AttritionSummaryT> {
    return request(`/api/v1/attrition/summary`, AttritionSummary);
  },

  /**
   * GET /api/v1/employees/:id/attrition — one employee's attrition view.
   *
   * Returns the ROLE-APPROPRIATE shape (the API decides from the authenticated
   * role, never the client): the FULL `AttritionEmployeeView` (raw score + SHAP +
   * top drivers + narrative + recommended actions) for ADMIN / HRBP, or the
   * redacted `ManagerAttritionView` (TIER + recommended talking points ONLY) for
   * a MANAGER. Use `isFullAttritionView` to discriminate. The score is NEVER
   * shown to the employee — there is no employee-facing variant of this read.
   */
  getEmployeeAttrition(employeeId: string): Promise<AttritionView> {
    return request(`/api/v1/employees/${employeeId}/attrition`, AttritionView);
  },

  /**
   * PATCH /api/v1/employees/:id/attrition-opt-out — the employee's right to not be
   * profiled (spec ethics).
   *
   * Body conforms to the frozen `AttritionOptOutRequest` ({ optOut }). When
   * `optOut` is true the employee is EXCLUDED from scoring entirely (any existing
   * score is deleted and they are skipped on the next run). The API resolves the
   * tenant + authorisation server-side; this returns no body.
   */
  async setAttritionOptOut(employeeId: string, optOut: boolean): Promise<void> {
    await request(`/api/v1/employees/${employeeId}/attrition-opt-out`, z.unknown(), {
      method: "PATCH",
      body: { optOut },
    });
  },

  /**
   * POST /api/v1/attrition/bias-audit — the monthly tier-distribution disparity
   * audit (HRBP/ADMIN), reusing the Module 1 disparity engine.
   *
   * Body conforms to the frozen `AttritionBiasAuditRequest`: an org-supplied
   * `employeeId → group` demographic mapping (NEVER stored by PeopleOS) plus an
   * optional `selectionTiers` override (which tiers count as a "flagged" outcome;
   * default CRITICAL + HIGH). The API joins the mapping with current scores and
   * runs the disparity engine, returning the `DisparityReport` (selection-rate
   * parity, the 4/5ths ratio, and the >10pp disproportionate-flag) plus any
   * `unmatched` employees that had no current score.
   */
  attritionBiasAudit(
    input: AttritionBiasAuditRequestT,
  ): Promise<AttritionBiasAuditResponseT> {
    return request(`/api/v1/attrition/bias-audit`, AttritionBiasAuditResponse, {
      method: "POST",
      body: input,
    });
  },

  // ── Module 8 — Internal Talent Marketplace (mobility / succession / gigs) ───
  //
  // Matching is SKILL-GRAPH driven: the API reuses the Module 6 `skillGap`
  // primitive to derive each `matchScore` (= skill coverage), `readiness`
  // (READY_NOW / READY_SOON / STRETCH), and the matched / missing / gapSize
  // breakdown — the client never computes a match. GOVERNANCE: `flightRisk` on
  // internal candidates / successors is the Module 7 attrition TIER ONLY (never
  // the raw score), and the API returns it non-null ONLY to ADMIN / HRBP viewers
  // (null for everyone else); the UI shows the badge only when it is present. An
  // employee acts on their OWN behalf — apply / express interest resolve the
  // acting employee from the authenticated session, so the client sends only the
  // target id. As elsewhere, `orgId` + the AI `orgContext` are assembled
  // server-side; every response is validated against the frozen contracts.

  /**
   * GET /api/v1/employees/:id/recommended-roles — "recommended for you" (8a).
   *
   * Returns `RecommendedRoles`: open internal roles matched to this employee's
   * skills, each with its `matchScore` (skill coverage), `readiness` badge, the
   * matched / missing skills + `gapSize`, and `alreadyApplied`. All API-computed
   * from the tenant-scoped skill graph; ranked best-first server-side.
   */
  getRecommendedRoles(employeeId: string): Promise<RecommendedRolesT> {
    return request(
      `/api/v1/employees/${employeeId}/recommended-roles`,
      RecommendedRoles,
    );
  },

  /**
   * POST /api/v1/internal-applications — apply to / express interest in an
   * internal role on the acting employee's OWN behalf (8a).
   *
   * Body conforms to the frozen `CreateInternalApplicationRequest`
   * ({ jobOpeningId, note? }). The API resolves the acting `employeeId` from the
   * authenticated session (an employee acts only for themselves) and computes the
   * `matchScore` from the skill graph; the client never sends an employee id.
   * Returns the persisted `InternalApplication`.
   */
  applyInternal(
    input: CreateInternalApplicationRequestT,
  ): Promise<InternalApplicationT> {
    return request(`/api/v1/internal-applications`, InternalApplication, {
      method: "POST",
      body: input,
    });
  },

  /**
   * GET /api/v1/internal-applications — internal applications for the viewer.
   *
   * Returns `InternalApplicationView[]` (each joined with the role title +
   * applicant name + status + matchScore) from the `{ items }` envelope. The API
   * scopes the rows to the viewer server-side: an employee sees their OWN
   * applications, a recruiter / HRBP sees the org's pipeline. Tenant-scoped.
   */
  async listInternalApplications(): Promise<InternalApplicationViewT[]> {
    const env = await request(
      `/api/v1/internal-applications`,
      InternalApplicationListEnvelope,
    );
    return env.items;
  },

  /**
   * PATCH /api/v1/internal-applications/:id — move an internal application along
   * the pipeline (recruiter / HRBP).
   *
   * Body conforms to the frozen `UpdateInternalApplicationStatusRequest`
   * ({ status }). Authorisation (only a recruiter / HRBP may advance / reject /
   * hire) is enforced server-side. Returns the updated `InternalApplicationView`.
   */
  updateInternalApplicationStatus(
    applicationId: string,
    status: InternalAppStatusT,
  ): Promise<InternalApplicationViewT> {
    return request(
      `/api/v1/internal-applications/${applicationId}`,
      InternalApplicationView,
      { method: "PATCH", body: { status } },
    );
  },

  /**
   * GET /api/v1/jobs/:id/internal-candidates — "who internally could fill this
   * role?" (8b, recruiter / HRBP).
   *
   * Returns `RoleMatchResult`: the role's `requiredSkills` and its ranked
   * internal `candidates`, each with `matchScore`, `readiness`, matched / missing
   * skills + `gapSize`, and `flightRisk` (the Module 7 attrition TIER — non-null
   * ONLY for ADMIN / HRBP viewers, null otherwise). API-computed + role-gated.
   */
  getInternalCandidates(jobId: string): Promise<RoleMatchResultT> {
    return request(`/api/v1/jobs/${jobId}/internal-candidates`, RoleMatchResult);
  },

  /**
   * GET /api/v1/jobs/:id/succession — the succession plan for a role (8d).
   *
   * Returns `SuccessionPlan`: the `benchStrength`, the `readyNow` / `readySoon`
   * counts, and the ranked `successors` (each with readiness + matchScore +
   * gapSize + the role-gated `flightRisk` tier). Used for the senior/critical-role
   * succession view. API-computed from the skill graph + attrition tiers.
   */
  getSuccession(jobId: string): Promise<SuccessionPlanT> {
    return request(`/api/v1/jobs/${jobId}/succession`, SuccessionPlan);
  },

  /**
   * GET /api/v1/mobility/analytics — internal-mobility analytics (HRBP /
   * leadership), the source of Module 5's 5b `internalMobilityRate`.
   *
   * Returns `MobilityAnalytics`: the `internalFillRate` (internal / all hires)
   * and `internalMobilityRate` (internal moves / headcount), the count of
   * `openInternalRoles`, `totalInternalApplications`, `hiredInternally`, and the
   * `byDepartment` internal-hire breakdown. All API-computed + tenant-scoped.
   */
  getMobilityAnalytics(): Promise<MobilityAnalyticsT> {
    return request(`/api/v1/mobility/analytics`, MobilityAnalytics);
  },

  /**
   * GET /api/v1/gigs — the gig / stretch marketplace listing (8c).
   *
   * Returns the org's `Gig[]` (title + description + requiredSkills + duration +
   * status) from the `{ items }` envelope, for the browse view. Tenant-scoped.
   */
  async listGigs(): Promise<GigT[]> {
    const env = await request(`/api/v1/gigs`, GigListEnvelope);
    return env.items;
  },

  /**
   * POST /api/v1/gigs — post a gig / stretch assignment (manager / HRBP) (8c).
   *
   * Body conforms to the frozen `CreateGigRequest` ({ title, description,
   * requiredSkills, durationWeeks? }). The API resolves `orgId` and the creating
   * user from the session; returns the persisted `Gig`.
   */
  createGig(input: CreateGigRequestT): Promise<GigT> {
    return request(`/api/v1/gigs`, Gig, { method: "POST", body: input });
  },

  /**
   * POST /api/v1/gigs/:id/interest — express interest in a gig on the acting
   * employee's OWN behalf (8c).
   *
   * The API resolves the acting `employeeId` from the authenticated session (an
   * employee acts only for themselves), so the client sends only the gig id. Per
   * the spec, expressing interest notifies the HRBP without alerting the
   * employee's manager. Fire-and-forget from the UI's perspective (no body).
   */
  async expressGigInterest(gigId: string): Promise<void> {
    await request(`/api/v1/gigs/${gigId}/interest`, z.unknown(), {
      method: "POST",
    });
  },

  /**
   * GET /api/v1/employees/:id/recommended-gigs — recommended gigs (8c).
   *
   * Returns `RecommendedGigs`: gigs matched to this employee's skills, each with
   * its `matchScore` (skill coverage) + matched / missing skills + duration.
   * API-computed from the tenant-scoped skill graph; ranked best-first.
   */
  getRecommendedGigs(employeeId: string): Promise<RecommendedGigsT> {
    return request(
      `/api/v1/employees/${employeeId}/recommended-gigs`,
      RecommendedGigs,
    );
  },

  /**
   * POST /api/v1/employees/:id/mobility-fit?jobOpeningId=… — the AI move-fit +
   * development plan for an employee against a target role (Module 8 AI surface).
   *
   * The API assembles the frozen `MobilityRecommendRequest` server-side — it
   * recomputes the skill-graph match (requiredSkills / matchedSkills /
   * missingSkills / readiness) for the (employee, role) pair and adds the non-PII
   * `employeeContext` (role / level / department — NO name, NO demographics) and
   * `orgContext` — then calls the Python AI service (claude-sonnet-4-6). The
   * client passes only the employee id + the target role id. Returns the
   * `MobilityFitResponse` envelope: { jobOpeningId, match (matchScore / readiness /
   * matched / missing / gapSize), recommendation (the grounded fitSummary +
   * developmentPlan + confidence + biasCheck) }.
   */
  getMobilityFit(
    employeeId: string,
    jobOpeningId: string,
  ): Promise<MobilityFitResponse> {
    const qs = `?jobOpeningId=${encodeURIComponent(jobOpeningId)}`;
    return request(
      `/api/v1/employees/${employeeId}/mobility-fit${qs}`,
      MobilityFitResponse,
    );
  },

  // ── Module 9 — Workflow Automation Engine ──────────────────────────────────
  //
  // HR processes are a DURABLE, DB-persisted state machine over Postgres (the dev
  // engine; Temporal is the documented prod execution substrate). A
  // `WorkflowDefinition` is a DAG of steps; starting one creates a
  // `WorkflowInstance` that the engine walks, materialising a `WorkflowTask` for
  // each human step (TASK / APPROVAL / TIMER). The API owns ALL the durable
  // correctness properties server-side: every transition is persisted (resumable),
  // the engine caps iterations + guards revisits (a BRANCH may point backwards),
  // branch conditions are evaluated by a SAFE declarative comparator over
  // `instance.context` (field/op/value — never eval), SLA timers + escalation are
  // driven by the worker tick, and task completion is AUTHORISED (only the
  // assignee or their role, or ADMIN / HRBP). As elsewhere, `orgId` and the AI
  // `orgContext` are assembled server-side from the authenticated session; the
  // web client sends only the user-supplied inputs and validates every response
  // against the frozen contracts.

  /**
   * GET /api/v1/workflows — the org's workflow definitions / templates.
   *
   * Returns the `WorkflowDefinition[]` (the step DAG, trigger, eventType,
   * version, active flag) from the `{ items }` envelope, for the templates list.
   * Tenant-scoped server-side.
   */
  async listWorkflowDefinitions(): Promise<WorkflowDefinitionT[]> {
    const env = await request(`/api/v1/workflow-definitions`, WorkflowDefinitionListEnvelope);
    return env.items;
  },

  /** GET /api/v1/workflow-definitions/:id — a single workflow definition (with its steps). */
  getWorkflowDefinition(definitionId: string): Promise<WorkflowDefinitionT> {
    return request(`/api/v1/workflow-definitions/${definitionId}`, WorkflowDefinition);
  },

  /**
   * POST /api/v1/workflow-definitions/:id/start — start an instance of a definition.
   *
   * Body conforms to the frozen `StartWorkflowRequest` ({ subjectType?,
   * subjectId?, context? }). The engine creates the durable `WorkflowInstance`,
   * runs the auto steps inline (NOTIFICATION / AI_TASK / BRANCH) and stops at the
   * first human step (WAITING), then returns the `WorkflowInstanceDetail` (the
   * instance + its materialised task timeline) so the UI can route to the monitor.
   */
  startWorkflow(
    definitionId: string,
    input: StartWorkflowRequestT = {},
  ): Promise<WorkflowInstanceDetailT> {
    return request(`/api/v1/workflow-definitions/${definitionId}/start`, WorkflowInstanceDetail, {
      method: "POST",
      body: input,
    });
  },

  /**
   * GET /api/v1/workflow-instances — the org's workflow instances.
   *
   * Returns the `WorkflowInstance[]` (status + currentStepId + subject +
   * startedAt) from the `{ items }` envelope, for the instances list. Tenant-scoped.
   */
  async listWorkflowInstances(): Promise<WorkflowInstanceT[]> {
    const env = await request(
      `/api/v1/workflow-instances`,
      WorkflowInstanceListEnvelope,
    );
    return env.items;
  },

  /**
   * GET /api/v1/workflow-instances/:id — the instance MONITOR view.
   *
   * Returns `WorkflowInstanceDetail`: the instance (status / current step /
   * context / timestamps) joined with its definition key + name AND the full task
   * TIMELINE (each task's type / status / assignee / due / outcome). Used to
   * render the live monitor with overdue tasks highlighted.
   */
  getWorkflowInstance(instanceId: string): Promise<WorkflowInstanceDetailT> {
    return request(
      `/api/v1/workflow-instances/${instanceId}`,
      WorkflowInstanceDetail,
    );
  },

  /**
   * POST /api/v1/workflow-instances/:id/cancel — cancel a running instance.
   *
   * Transitions the instance to CANCELLED (and skips its open tasks) durably.
   * Authorisation (ADMIN / HRBP) is enforced server-side. Returns the updated
   * `WorkflowInstanceDetail` so the monitor re-renders the cancelled state.
   */
  cancelWorkflowInstance(instanceId: string): Promise<WorkflowInstanceDetailT> {
    return request(
      `/api/v1/workflow-instances/${instanceId}/cancel`,
      WorkflowInstanceDetail,
      { method: "POST" },
    );
  },

  /**
   * GET /api/v1/workflow-tasks?mine=1 — the human tasks/approvals assigned to me.
   *
   * Returns the `WorkflowTask[]` (the TASK / APPROVAL / TIMER steps assigned to
   * the viewer directly or by their role) from the `{ items }` envelope, for the
   * "My tasks" inbox. The API resolves the acting user + their role from the
   * session and scopes the rows accordingly; tenant-scoped.
   */
  async listMyWorkflowTasks(): Promise<WorkflowTaskT[]> {
    const env = await request(`/api/v1/workflow-tasks?mine=1`, WorkflowTaskListEnvelope);
    return env.items;
  },

  /**
   * POST /api/v1/workflow-tasks/:id/complete — approve / complete a human task.
   *
   * Body conforms to the frozen `CompleteTaskRequest` ({ outcome?, note? }) — an
   * APPROVAL records APPROVED / REJECTED, a TASK records DONE. The API AUTHORISES
   * completion (only the assignee or their role, or ADMIN / HRBP), records the
   * outcome durably, and advances the instance (evaluating any BRANCH on the
   * outcome it wrote into `context`). Returns the advanced `WorkflowInstanceDetail`.
   */
  completeWorkflowTask(
    taskId: string,
    input: CompleteTaskRequestT = {},
  ): Promise<WorkflowInstanceDetailT> {
    return request(`/api/v1/workflow-tasks/${taskId}/complete`, WorkflowInstanceDetail, {
      method: "POST",
      body: input,
    });
  },

  /**
   * GET /api/v1/workflow-monitor — the org workflow monitor (ADMIN / HRBP).
   *
   * Returns `WorkflowMonitor`: instances grouped `byStatus`, the org-wide
   * `overdueTasks` count, and the `recentInstances` summaries. All API-computed
   * and tenant-scoped; role-gated to ADMIN / HRBP server-side.
   */
  getWorkflowMonitor(): Promise<WorkflowMonitorT> {
    return request(`/api/v1/workflow-monitor`, WorkflowMonitor);
  },

  /**
   * POST /api/v1/workflow-definitions/draft — AI-draft a workflow from a description.
   *
   * The client sends only the natural-language `description`; the API supplies the
   * tenant `orgId` and the AI `orgContext` server-side (the frozen
   * `DraftWorkflowRequest`) and calls the Python AI service (claude-sonnet-4-6),
   * returning a proposed `name` / `trigger` / `eventType` and the drafted step DAG
   * with a `confidence` level. The draft is ADVISORY — a human reviews it before it
   * is created; this endpoint does NOT persist a definition.
   */
  draftWorkflow(description: string): Promise<DraftWorkflowResponseT> {
    return request(`/api/v1/workflow-definitions/draft`, DraftWorkflowResponse, {
      method: "POST",
      body: { description },
    });
  },

  /**
   * POST /api/v1/workflow-events — emit a domain EVENT to start matching
   * workflows.
   *
   * Body conforms to the frozen `EmitEventRequest` ({ eventType, subjectType?,
   * subjectId?, context? }) — the dev surface for the event triggers the spec
   * consumes from Kafka in production (EMPLOYEE_HIRED, RESIGNATION_SUBMITTED, …).
   * The API matches the event against active EVENT-triggered definitions, starts
   * an instance for each, and returns the `EmitEventResponse` listing every
   * `{ instanceId, definitionKey }` it started.
   */
  emitWorkflowEvent(input: EmitEventRequestT): Promise<EmitEventResponseT> {
    return request(`/api/v1/workflow-events`, EmitEventResponse, {
      method: "POST",
      body: input,
    });
  },

  // ── Module 10 — Agentic HR Assistant (the capstone orchestrator) ───────────
  //
  // An org-wide, ROLE-AWARE agent that orchestrates every prior module's
  // capability as a tool. The SECURITY MODEL is entirely server-side: the API
  // derives the trusted `AssistantContext` (orgId / userId / role) from the
  // AUTHENTICATED session — never from the client — and relays it to the Python
  // AI service, whose ReAct loop attaches it to EVERY internal tool dispatch
  // PROGRAMMATICALLY. The LLM never sees the context and tool args can never
  // carry/override identity. The secret-authed `/internal/assistant/*`
  // dispatcher RE-ENFORCES tenancy + per-tool role governance from that context
  // (attrition TIER-only for managers, employees see only their own data, …),
  // so a (prompt-injected) agent can never become a confused deputy. Write tools
  // (raise_hr_ticket / start_workflow / generate_outreach) are audited and the
  // agent confirms intent first.
  //
  // The web client therefore sends only the user's message (+ the running
  // `sessionId` to continue a conversation) and reads its OWN session history;
  // every response is validated against the frozen `@peopleos/schemas` contracts.

  /**
   * POST /api/v1/assistant/chat — one turn with the PeopleOS Assistant.
   *
   * Body conforms to the frozen `AssistantChatRequest` ({ message, sessionId? }).
   * Omit `sessionId` to start a new session; pass the returned id on every
   * subsequent turn to continue the conversation. The API persists the turn,
   * relays the trusted `AssistantContext` to the AI ReAct loop, and returns the
   * `AssistantChatResponse`: the `sessionId`, the assistant's `reply`, a
   * SUMMARISED `toolCalls` trace (tool · ok · summary — never raw, possibly
   * sensitive tool output), and role-aware `suggestedActions` for the UI.
   */
  assistantChat(input: AssistantChatRequestT): Promise<AssistantChatResponseT> {
    return request(`/api/v1/assistant/chat`, AssistantChatResponse, {
      method: "POST",
      body: input,
    });
  },

  /**
   * GET /api/v1/assistant/sessions — the caller's OWN assistant sessions.
   *
   * Returns the `AssistantSessionSummary[]` (id + title + updatedAt) from the
   * `{ items }` envelope, for the history sidebar, newest-first. The API scopes
   * the rows to the authenticated caller (userId) + org server-side; the client
   * never sends a userId or orgId.
   */
  async listAssistantSessions(): Promise<AssistantSessionSummaryT[]> {
    const env = await request(
      `/api/v1/assistant/sessions`,
      AssistantSessionListEnvelope,
    );
    return env.items;
  },

  /**
   * GET /api/v1/assistant/sessions/:id — replay one session's full transcript.
   *
   * Returns `AssistantSessionDetail`: the session metadata plus its persisted
   * `AssistantMessage[]` (user + assistant turns, each assistant turn carrying
   * its summarised `toolCalls` trace) for resuming a conversation. Scoped to the
   * caller server-side — a caller can only read their own sessions.
   */
  getAssistantSession(sessionId: string): Promise<AssistantSessionDetailT> {
    return request(
      `/api/v1/assistant/sessions/${sessionId}`,
      AssistantSessionDetail,
    );
  },
};

/**
 * Employee-supplied subset of the frozen `AskRequest`. The employee types a
 * `message`; the client carries the running `sessionId` (omit/null to start a
 * new conversation) and pins `channel` to "WEB". `orgId` + the non-PII
 * `employeeContext` are resolved server-side from the authenticated session.
 */
export type AskHrChatInput = {
  message: string;
  sessionId?: string | null;
};

/** The frozen `PolicyDocType` enum, re-exported for the upload form's select. */
export type PolicyDocType = PolicyDocTypeT;

/**
 * Recruiter-supplied JD brief. This is the subset of the frozen
 * `WriteJobDescriptionRequest` the recruiter fills in the JD Writer form; the
 * API adds `orgId`, `orgContext`, and `priorJdExamples` server-side. Typed off
 * the shared `RoleLevel` enum — no locally-redeclared wire shapes.
 */
export type WriteJdInput = {
  roleTitle: string;
  seniority?: RoleLevelT | null;
  department?: string | null;
  teamContext?: string | null;
  hiringManagerNotes?: string | null;
};

/**
 * Reviewer-supplied subset of the frozen `CreateInterviewRequest`. `orgId` is
 * resolved server-side from the session; `consentObtained` is added by the
 * client as the frozen `true` literal (the contract forbids creating an
 * interview without candidate consent). Typed off the branded ids only.
 */
export type CreateInterviewInput = {
  applicationId: ApplicationIdT;
  interviewerIds?: UserIdLike[];
  scheduledAt?: string | null;
  durationMinutes?: number | null;
  type?: "PHONE" | "VIDEO" | "ONSITE" | "TECHNICAL";
};

/** Branded `UserId` is assignable from a string at the call site after parse. */
type UserIdLike = string & { readonly __brand?: "UserId" };

/**
 * Reviewer's final scorecard submission — exactly the frozen
 * `SubmitScorecardRequest` shape (per-competency 1-5 score + optional evidence,
 * plus the overall recommendation). No locally-redeclared wire fields beyond
 * the contract; typed off the frozen `ScorecardRecommendation` enum.
 */
export type SubmitScorecardInput = {
  competencyScores: Array<{
    competencyId: string;
    score: number;
    evidence?: string | null;
  }>;
  overallRecommendation: ScorecardRecommendationT;
};
