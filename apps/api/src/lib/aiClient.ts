import { request as undiciRequest } from "undici";
import { z } from "zod";
import {
  AiHealth,
  AnalyticsNarrativeRequest,
  AnalyticsNarrativeResponse,
  AnalyzeInterviewRequest,
  AnalyzeInterviewResponse,
  AnalyzeLinkedInRequest,
  AnalyzeLinkedInResponse,
  AskDataRequest,
  AskDataResponse,
  AssistantChatAiRequest,
  AssistantChatAiResponse,
  BuildVsBuyRequest,
  BuildVsBuyResponse,
  CandidateRanking,
  ChatAnswerRequest,
  ChatAnswerResponse,
  DisparityReport,
  DisparityRequest,
  DraftWorkflowRequest,
  DraftWorkflowResponse,
  EmbedRequest,
  EmbedResponse,
  ExplainAttritionRequest,
  ExplainAttritionResponse,
  GeneratedJobDescription,
  GenerateOutreachRequest,
  GrowthPathRequest,
  GrowthPathResponse,
  MobilityRecommendRequest,
  MobilityRecommendResponse,
  OutreachResult,
  ParseJobDescriptionRequest,
  ParseJobDescriptionResponse,
  ParseResumeRequest,
  ParseResumeResponse,
  PolicyIngestRequest,
  PolicyIngestResponse,
  RecruiterChatRequest,
  RecruiterChatResponse,
  ScoreAttritionRequest,
  ScoreAttritionResponse,
  ScoreBatchRequest,
  ScoreBatchResponse,
  ScoreCandidateRequest,
  ScoreCandidateResponse,
  TranscribeRequest,
  TranscribeResponse,
  WriteJobDescriptionRequest,
} from "@peopleos/schemas";
import { env } from "../env.js";

/**
 * Per-request timeout for calls to the AI service. A single LLM call targets 30s
 * (spec Layer 4), but the Module 2c / Module 10 endpoints run a multi-step ReAct
 * loop (several sequential model calls + tool round-trips) behind one HTTP request,
 * so the client budget must cover the whole loop — especially on slower large /
 * self-hosted models. A longer ceiling never slows a fast single-shot call; it only lets
 * the agentic loop finish instead of being cut off mid-reasoning (UND_ERR_HEADERS_TIMEOUT).
 */
const AI_TIMEOUT_MS = 180_000;

/**
 * Raised when the AI service is unreachable, times out, returns a non-2xx, or
 * returns a body that fails contract validation. The route layer maps this to a
 * 502 with the uniform ApiError envelope — a downstream-dependency failure is a
 * Bad Gateway from the API's perspective, never the client's fault.
 */
export class AiServiceError extends Error {
  readonly code = "AI_SERVICE_ERROR";
  readonly status: number;
  readonly details: unknown;
  constructor(message: string, status = 502, details?: unknown) {
    super(message);
    this.name = "AiServiceError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Typed POST helper: validates the outgoing body against the request schema,
 * calls the AI service, then validates the response against the response schema.
 * Nothing leaves or enters this client unvalidated (prompt standard #5: every AI
 * output is Zod-parsed before it is trusted).
 */
async function postValidated<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(
  path: string,
  body: z.infer<Req>,
  reqSchema: Req,
  resSchema: Res,
): Promise<{ data: z.infer<Res>; raw: unknown }> {
  const parsedReq = reqSchema.safeParse(body);
  if (!parsedReq.success) {
    // Programmer error: we are about to send a contract-violating request.
    throw new AiServiceError(
      `AI request validation failed for ${path}`,
      500,
      parsedReq.error.flatten(),
    );
  }

  const url = `${env.AI_SERVICE_URL}${path}`;
  let res: Awaited<ReturnType<typeof undiciRequest>>;
  try {
    res = await undiciRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(parsedReq.data),
      headersTimeout: AI_TIMEOUT_MS,
      bodyTimeout: AI_TIMEOUT_MS,
    });
  } catch (err) {
    throw new AiServiceError(
      `AI service request to ${path} failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new AiServiceError(
      `AI service returned ${res.statusCode} for ${path}`,
      502,
      safeJson(text),
    );
  }

  const raw = safeJson(text);
  const parsedRes = resSchema.safeParse(raw);
  if (!parsedRes.success) {
    throw new AiServiceError(
      `AI service response for ${path} failed contract validation`,
      502,
      parsedRes.error.flatten(),
    );
  }
  return { data: parsedRes.data, raw };
}

/**
 * The chain-of-thought reasoning is intentionally NOT part of the frozen
 * `CandidateRanking` contract (prompt standard #3: CoT is never returned to
 * clients). The AI service emits it as a sibling `reasoning` field on the raw
 * score response, which the contract schema strips. We extract it here from the
 * raw body so the API can persist it to the audit-only `reasoning` column while
 * the validated `CandidateRanking` it returns to callers stays CoT-free.
 */
const ReasoningEnvelope = z.object({ reasoning: z.string().optional() });

function extractReasoning(raw: unknown): string | null {
  const parsed = ReasoningEnvelope.safeParse(raw);
  return parsed.success ? (parsed.data.reasoning ?? null) : null;
}

/**
 * Batch sibling-reasoning envelope. The score-batch endpoint mirrors the single
 * `/v1/ranking/score` shape per item: each `rankings[i]` carries an extra
 * `reasoning` (chain-of-thought) that the strict `ScoreBatchResponse` contract
 * strips. We read it positionally from the RAW body so the API can persist each
 * ranking's CoT to its audit-only column while the validated, returned rankings
 * stay CoT-free (prompt standard #3).
 */
const BatchReasoningEnvelope = z.object({
  rankings: z.array(z.object({ reasoning: z.string().optional() }).passthrough()).optional(),
});

function extractBatchReasonings(raw: unknown): Array<string | null> {
  const parsed = BatchReasoningEnvelope.safeParse(raw);
  if (!parsed.success || !parsed.data.rankings) return [];
  return parsed.data.rankings.map((item) => item.reasoning ?? null);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Typed client for services/ai. Each method mirrors a frozen contract in
 * @peopleos/schemas (ai.ts). The AI service emits camelCase JSON to honour the
 * shared convention, so the schemas validate its responses directly.
 */
export const aiClient = {
  /** GET /health on the AI service — used by the API health route. */
  async health(): Promise<z.infer<typeof AiHealth>> {
    const url = `${env.AI_SERVICE_URL}/health`;
    let res: Awaited<ReturnType<typeof undiciRequest>>;
    try {
      res = await undiciRequest(url, {
        method: "GET",
        headers: { accept: "application/json" },
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
    } catch (err) {
      throw new AiServiceError(
        `AI health check failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new AiServiceError(`AI health check returned ${res.statusCode}`);
    }
    const parsed = AiHealth.safeParse(safeJson(text));
    if (!parsed.success) {
      throw new AiServiceError("AI health response failed contract validation", 502, parsed.error.flatten());
    }
    return parsed.data;
  },

  /** POST /v1/resume/parse — resume → structured CandidateProfile (spec Layer 2A). */
  async parseResume(
    req: z.infer<typeof ParseResumeRequest>,
  ): Promise<z.infer<typeof ParseResumeResponse>> {
    const { data } = await postValidated(
      "/v1/resume/parse",
      req,
      ParseResumeRequest,
      ParseResumeResponse,
    );
    return data;
  },

  /** POST /v1/jd/parse — free-text JD → JDStructured (Module 1 step 1). */
  async parseJobDescription(
    req: z.infer<typeof ParseJobDescriptionRequest>,
  ): Promise<z.infer<typeof ParseJobDescriptionResponse>> {
    const { data } = await postValidated(
      "/v1/jd/parse",
      req,
      ParseJobDescriptionRequest,
      ParseJobDescriptionResponse,
    );
    return data;
  },

  /** POST /v1/ranking/score — full Module 1 ranking pipeline → CandidateRanking. */
  async score(
    req: z.infer<typeof ScoreCandidateRequest>,
  ): Promise<z.infer<typeof ScoreCandidateResponse>> {
    const { data } = await postValidated(
      "/v1/ranking/score",
      req,
      ScoreCandidateRequest,
      ScoreCandidateResponse,
    );
    return data;
  },

  /**
   * Like `score`, but also returns the (audit-only) chain-of-thought reasoning the
   * AI service emits alongside the contract. Used by the ranking route to persist
   * `reasoning` to the DB while the returned `CandidateRanking` stays CoT-free.
   */
  async scoreWithReasoning(
    req: z.infer<typeof ScoreCandidateRequest>,
  ): Promise<{ ranking: z.infer<typeof ScoreCandidateResponse>; reasoning: string | null }> {
    const { data, raw } = await postValidated(
      "/v1/ranking/score",
      req,
      ScoreCandidateRequest,
      ScoreCandidateResponse,
    );
    return { ranking: data, reasoning: extractReasoning(raw) };
  },

  /**
   * POST /v1/ranking/score-batch — score many candidates against one job in a
   * single call (Module 1, parallelised across an applicant batch). Returns the
   * validated `rankings` (CoT-free) PLUS the audit-only per-item `reasoning`
   * extracted from the raw body, aligned BY INDEX with `rankings`. The pipeline
   * service persists each ranking with its matching reasoning to the DB and never
   * returns reasoning to clients (prompt standard #3).
   */
  async scoreBatch(req: z.infer<typeof ScoreBatchRequest>): Promise<{
    rankings: z.infer<typeof CandidateRanking>[];
    reasonings: Array<string | null>;
  }> {
    const { data, raw } = await postValidated(
      "/v1/ranking/score-batch",
      req,
      ScoreBatchRequest,
      ScoreBatchResponse,
    );
    const reasonings = extractBatchReasonings(raw);
    // Align positionally with `rankings`; pad with null if the AI service omitted
    // any sibling reasoning so indices never go out of range.
    const aligned = data.rankings.map((_, i) => reasonings[i] ?? null);
    return { rankings: data.rankings, reasonings: aligned };
  },

  /**
   * POST /v1/audit/disparity — adverse-impact / selection-rate parity statistics
   * (EEOC 4/5ths rule + score distribution) for a set of scored candidates tagged
   * with provided demographic group labels. No LLM is involved; PeopleOS does not
   * store protected attributes — they arrive only in this request.
   */
  async disparity(
    req: z.infer<typeof DisparityRequest>,
  ): Promise<z.infer<typeof DisparityReport>> {
    const { data } = await postValidated(
      "/v1/audit/disparity",
      req,
      DisparityRequest,
      DisparityReport,
    );
    return data;
  },

  // ── Module 2 — Recruiter Copilot ───────────────────────────────────────────

  /**
   * POST /v1/copilot/jd-writer — Module 2a JD Writer. The API supplies the org's
   * prior JD texts (priorJdExamples) for tone-matched few-shot retrieval and the
   * OrgContext; the AI service returns a full GeneratedJobDescription with an
   * inclusive-language report + biasCheck (prompt standard #4).
   */
  async writeJd(
    req: z.infer<typeof WriteJobDescriptionRequest>,
  ): Promise<z.infer<typeof GeneratedJobDescription>> {
    const { data } = await postValidated(
      "/v1/copilot/jd-writer",
      req,
      WriteJobDescriptionRequest,
      GeneratedJobDescription,
    );
    return data;
  },

  /**
   * POST /v1/copilot/outreach — Module 2b Candidate Outreach Generator. The
   * candidate profile is NOT masked here (unlike Module 1 scoring): outreach is
   * personalised to the real person by design. Returns tone variants + an InMail
   * + subject-line A/B options, each with a biasCheck.
   */
  async outreach(
    req: z.infer<typeof GenerateOutreachRequest>,
  ): Promise<z.infer<typeof OutreachResult>> {
    const { data } = await postValidated(
      "/v1/copilot/outreach",
      req,
      GenerateOutreachRequest,
      OutreachResult,
    );
    return data;
  },

  /**
   * POST /v1/copilot/chat — Module 2c Recruiter Chat Assistant (LangGraph ReAct
   * agent). The orgId on the request MUST originate from the caller's authenticated
   * session (never the client body); the AI service's tools call back into this
   * API's /internal/copilot/* router with that same orgId. Returns a CoT-free
   * answer plus a summarised tool trace.
   */
  async chat(
    req: z.infer<typeof RecruiterChatRequest>,
  ): Promise<z.infer<typeof RecruiterChatResponse>> {
    const { data } = await postValidated(
      "/v1/copilot/chat",
      req,
      RecruiterChatRequest,
      RecruiterChatResponse,
    );
    return data;
  },

  /**
   * POST /v1/copilot/linkedin/analyze — Module 2d LinkedIn sidebar. The API
   * supplies the org's OPEN roles to benchmark against (the AI service cannot query
   * the DB); consent is enforced by the contract (consent: literal true). Returns a
   * structured CandidateProfile, per-role match scores, and a biasCheck.
   */
  async analyzeLinkedIn(
    req: z.infer<typeof AnalyzeLinkedInRequest>,
  ): Promise<z.infer<typeof AnalyzeLinkedInResponse>> {
    const { data } = await postValidated(
      "/v1/copilot/linkedin/analyze",
      req,
      AnalyzeLinkedInRequest,
      AnalyzeLinkedInResponse,
    );
    return data;
  },

  // ── Module 3 — Interview Intelligence & Summaries ──────────────────────────

  /**
   * POST /v1/interview/transcribe — Module 3 transcription. The AI service runs
   * SELF-HOSTED WhisperX (large-v3 + diarisation) on GPU for data privacy (interview
   * audio is highly sensitive; never sent to a hosted ASR). Because the GPU worker is
   * auto-scaled from zero, this endpoint can return 503 while a worker spins up — that
   * is EXPECTED. `postValidated` maps any non-2xx (incl. 503) to a clean 502
   * `AiServiceError`, so the route surfaces a uniform ApiError instead of leaking the
   * upstream status; the caller can retry once a worker is warm.
   */
  async transcribeInterview(
    req: z.infer<typeof TranscribeRequest>,
  ): Promise<z.infer<typeof TranscribeResponse>> {
    const { data } = await postValidated(
      "/v1/interview/transcribe",
      req,
      TranscribeRequest,
      TranscribeResponse,
    );
    return data;
  },

  /**
   * POST /v1/interview/analyze — Module 3 transcript analysis (the 4 steps: competency
   * /STAR extraction, structured scorecard draft, executive summary, per-transcript
   * calibration flags incl. leading/illegal questions). The 7 prompt-engineering
   * standards (XML system prompt + output schema + few-shot, validation/retry, a
   * biasCheck on the HR-facing draft, privacy guard discarding personal disclosures)
   * are applied in the AI service. The response is Zod-validated against the frozen
   * `AnalyzeInterviewResponse` contract before it is trusted.
   */
  async analyzeInterview(
    req: z.infer<typeof AnalyzeInterviewRequest>,
  ): Promise<z.infer<typeof AnalyzeInterviewResponse>> {
    const { data } = await postValidated(
      "/v1/interview/analyze",
      req,
      AnalyzeInterviewRequest,
      AnalyzeInterviewResponse,
    );
    return data;
  },

  // ── Module 4 — Company knowledge base + Employee HR Chatbot (RAG) ───────────

  /**
   * POST /v1/policy/ingest — Layer 2C document (policy) pipeline. Sends the raw
   * policy text; the AI service builds the section outline, semantically chunks
   * (≤1200 tokens, 15% overlap), embeds each chunk (text-embedding-3-large), and
   * returns the chunks (with embeddings + section_path metadata) plus a SimHash
   * fingerprint for dedup/versioning. The API stores the chunks as DocumentChunk
   * rows and uses the SimHash + title to detect superseded prior versions.
   */
  async ingestPolicy(
    req: z.infer<typeof PolicyIngestRequest>,
  ): Promise<z.infer<typeof PolicyIngestResponse>> {
    const { data } = await postValidated(
      "/v1/policy/ingest",
      req,
      PolicyIngestRequest,
      PolicyIngestResponse,
    );
    return data;
  },

  /**
   * POST /v1/embed — embed a batch of texts (≤128) with the same embedding model
   * used by the policy pipeline, so the query vector lives in the same space as the
   * stored DocumentChunk embeddings. Used by the HR chatbot to embed the user's
   * query before hybrid retrieval (the dense half of dense+lexical fusion).
   */
  async embed(req: z.infer<typeof EmbedRequest>): Promise<z.infer<typeof EmbedResponse>> {
    const { data } = await postValidated("/v1/embed", req, EmbedRequest, EmbedResponse);
    return data;
  },

  /**
   * POST /v1/chat/answer — Module 4 grounded RAG answer (Claude claude-sonnet-4-6).
   * The API does retrieval and hands the AI service the top-k candidateChunks; the
   * AI service answers ONLY from those chunks, cites policy name + section +
   * effective_date for every claim, and SAYS SO (rather than inventing policy) when
   * the answer is not in context. Sensitive topics (termination, harassment, salary
   * dispute) or low confidence set `escalate=true` so the API opens an HR ticket.
   * The returned answer is already grounded — the API does not post-process it.
   */
  async chatAnswer(
    req: z.infer<typeof ChatAnswerRequest>,
  ): Promise<z.infer<typeof ChatAnswerResponse>> {
    const { data } = await postValidated(
      "/v1/chat/answer",
      req,
      ChatAnswerRequest,
      ChatAnswerResponse,
    );
    return data;
  },

  // ── Module 5 — Workforce Analytics Dashboard (AI narrative + "Ask your data") ──

  /**
   * POST /v1/analytics/narrative — Module 5e weekly AI narrative (Claude
   * claude-sonnet-4-6). The API computes the `DashboardMetrics` from Postgres and
   * hands them to the AI service; the service writes the "3 most important people
   * metrics" executive narrative, surfaces > 2σ anomalies, and is GROUNDED ONLY in
   * the supplied metrics — it never invents numbers and never generates SQL (prompt
   * standard #2: hallucination prevention). The metrics are validated against the
   * frozen `DashboardMetrics` contract before they leave the API, and the response
   * is validated against `AnalyticsNarrativeResponse` before it is trusted.
   */
  async narrative(
    req: z.infer<typeof AnalyticsNarrativeRequest>,
  ): Promise<z.infer<typeof AnalyticsNarrativeResponse>> {
    const { data } = await postValidated(
      "/v1/analytics/narrative",
      req,
      AnalyticsNarrativeRequest,
      AnalyticsNarrativeResponse,
    );
    return data;
  },

  /**
   * POST /v1/analytics/ask — Module 5e "Ask your data" NL query interface. The
   * client supplies only a natural-language question; the API computes the metrics
   * SERVER-SIDE and passes them here. The AI service answers ONLY from the supplied
   * metrics (no free-form SQL is ever generated against the warehouse), reports
   * which metric keys it drew on (`usedMetrics`, for transparency), and may attach a
   * `ChartSpec`. Both directions are Zod-validated by `postValidated`.
   */
  async askData(
    req: z.infer<typeof AskDataRequest>,
  ): Promise<z.infer<typeof AskDataResponse>> {
    const { data } = await postValidated(
      "/v1/analytics/ask",
      req,
      AskDataRequest,
      AskDataResponse,
    );
    return data;
  },

  // ── Module 6 — Employee Skill Graph (AI growth path + build-vs-buy) ──────────

  /**
   * POST /v1/skills/growth-path — Module 6a AI growth-path suggestions (Claude
   * claude-sonnet-4-6). The API computes the concrete skill gap from the graph
   * (employee's held skills vs the target role's required skills) and hands the AI
   * service the employee's skills, the target role + its required skills, and the
   * org's skill catalog. The service returns a grounded "you are N skills away"
   * narrative with per-skill recommendations + suggested training, a biasCheck
   * (prompt standard #4) and a confidence. It is GROUNDED ONLY in the supplied skills
   * (prompt standard #2) — it never invents skills the org's catalog does not contain.
   * Both directions are Zod-validated by `postValidated`.
   */
  async growthPath(
    req: z.infer<typeof GrowthPathRequest>,
  ): Promise<z.infer<typeof GrowthPathResponse>> {
    const { data } = await postValidated(
      "/v1/skills/growth-path",
      req,
      GrowthPathRequest,
      GrowthPathResponse,
    );
    return data;
  },

  /**
   * POST /v1/skills/build-vs-buy — Module 6c "Build vs Buy" recommender (Claude
   * claude-sonnet-4-6). The API computes the org-level signal for one skill (current
   * supply, open-role demand, and how many current employees are trainable into the
   * gap) and the AI service recommends BUILD / BUY / HYBRID with a rationale grounded
   * strictly in those numbers — it is advisory only (prompt standard: never makes
   * employment decisions autonomously). Both directions are Zod-validated.
   */
  async buildVsBuy(
    req: z.infer<typeof BuildVsBuyRequest>,
  ): Promise<z.infer<typeof BuildVsBuyResponse>> {
    const { data } = await postValidated(
      "/v1/skills/build-vs-buy",
      req,
      BuildVsBuyRequest,
      BuildVsBuyResponse,
    );
    return data;
  },

  // ── Module 7 — Attrition Prediction Engine (ML scorer + LLM explanation) ─────

  /**
   * POST /v1/attrition/score — the attrition risk SCORER. The API computes the
   * available `AttritionFeatures` per employee (tenure/perf/team/skill signals only —
   * never a protected attribute) and sends a batch; the AI service returns a calibrated
   * `riskScore` + `riskTier` + SHAP-style `topDrivers` + full `shapValues` per employee
   * (the transparent cold-start scorer for dev; XGBoost/LightGBM/SHAP/MLflow are the
   * documented prod adapter). No LLM is involved in scoring. The score is ADVISORY ONLY.
   * Both directions are Zod-validated by `postValidated`.
   */
  async scoreAttrition(
    req: z.infer<typeof ScoreAttritionRequest>,
  ): Promise<z.infer<typeof ScoreAttritionResponse>> {
    const { data } = await postValidated(
      "/v1/attrition/score",
      req,
      ScoreAttritionRequest,
      ScoreAttritionResponse,
    );
    return data;
  },

  /**
   * POST /v1/attrition/explain — the LLM explanation layer (Claude claude-sonnet-4-6).
   * Given a `riskTier` + the SHAP `topDrivers` + a NON-PII employee context (tenure /
   * role title / department / level — never name or demographics), the AI service writes
   * a plain-language narrative + recommended retention actions, GROUNDED ONLY in the
   * supplied drivers (prompt standard #2) with a `biasCheck` (prompt standard #4). It is
   * ADVISORY — it never recommends an automated HR action. Both directions are Zod-validated.
   */
  async explainAttrition(
    req: z.infer<typeof ExplainAttritionRequest>,
  ): Promise<z.infer<typeof ExplainAttritionResponse>> {
    const { data } = await postValidated(
      "/v1/attrition/explain",
      req,
      ExplainAttritionRequest,
      ExplainAttritionResponse,
    );
    return data;
  },

  // ── Module 8 — Internal Talent Marketplace (AI move recommendation) ──────────

  /**
   * POST /v1/mobility/recommend — Module 8 internal-move recommendation (Claude
   * claude-sonnet-4-6). The API computes the concrete skill match for an
   * (employee, target role) pair from the skill graph (matched/missing skills +
   * readiness) and hands it here; the AI service writes a grounded `fitSummary` + a
   * per-missing-skill `developmentPlan` (skill → action → suggested resource) with a
   * `biasCheck` (prompt standard #4) and a confidence. It is GROUNDED ONLY in the
   * supplied skills + readiness (prompt standard #2) — it never invents skills the role
   * does not require — and the employee context is NON-PII (role title / level /
   * department — never name or demographics). Advisory only. Both directions are
   * Zod-validated by `postValidated`.
   */
  async recommendMove(
    req: z.infer<typeof MobilityRecommendRequest>,
  ): Promise<z.infer<typeof MobilityRecommendResponse>> {
    const { data } = await postValidated(
      "/v1/mobility/recommend",
      req,
      MobilityRecommendRequest,
      MobilityRecommendResponse,
    );
    return data;
  },

  // ── Module 9 — Workflow Automation (AI draft-authoring surface) ──────────────

  /**
   * POST /v1/workflows/draft — Module 9 AI workflow authoring (Claude
   * claude-sonnet-4-6). Given a plain-language description of an HR process, the AI
   * service drafts a structured `WorkflowDefinition` skeleton: a name, a trigger, an
   * optional eventType, and an ordered list of `WorkflowStep`s (TASK/APPROVAL/
   * NOTIFICATION/AI_TASK/TIMER/BRANCH) with assignee roles + SLA hours, plus a
   * `confidence`. The 7 prompt-engineering standards are applied IN the AI service
   * (XML system prompt + output schema + few-shot, validation/retry, grounding so it
   * only emits the enum step types, an offline deterministic fallback). The draft is
   * ADVISORY — it is NEVER auto-persisted; a human reviews it and submits it through
   * POST /workflow-definitions. Both directions are Zod-validated by `postValidated`.
   *
   * The workflow engine's AI_TASK steps also call this (resiliently): an AI outage
   * never blocks the engine — the step is flagged for manual follow-up instead.
   */
  async draftWorkflow(
    req: z.infer<typeof DraftWorkflowRequest>,
  ): Promise<z.infer<typeof DraftWorkflowResponse>> {
    const { data } = await postValidated(
      "/v1/workflows/draft",
      req,
      DraftWorkflowRequest,
      DraftWorkflowResponse,
    );
    return data;
  },

  // ── Module 10 — Agentic HR Assistant (org-wide, role-aware ReAct agent) ──────

  /**
   * POST /v1/assistant/chat — Module 10 capstone agent (LangGraph/ReAct, Claude
   * claude-sonnet-4-6). The API loads-or-creates the caller's USER-SCOPED session,
   * supplies the recent history + the TRUSTED `context` { orgId, userId, role } (set
   * from the authenticated session — NEVER the client body), and the org's prompt
   * context. The AI service's agent attaches that context to EVERY tool dispatch
   * PROGRAMMATICALLY and calls back into this API's secret-authed
   * /internal/assistant/tool router, which re-enforces tenancy + per-tool role
   * governance from the SAME context. The LLM never sees the context and tool args can
   * never override orgId/userId/role — so the agent can never become a confused deputy.
   * Returns a CoT-free reply, a SUMMARISED tool trace (never raw tool output), and
   * role-aware suggested next actions. Both directions are Zod-validated by postValidated.
   */
  async assistantChat(
    req: z.infer<typeof AssistantChatAiRequest>,
  ): Promise<z.infer<typeof AssistantChatAiResponse>> {
    const { data } = await postValidated(
      "/v1/assistant/chat",
      req,
      AssistantChatAiRequest,
      AssistantChatAiResponse,
    );
    return data;
  },
};

export type AiClient = typeof aiClient;
