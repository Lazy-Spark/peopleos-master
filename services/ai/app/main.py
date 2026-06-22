"""FastAPI app for the PeopleOS AI Engine (spec Layer 4).

Routes (contract: services/ai/app/schemas.py mirrors @peopleos/schemas):
  GET  /health                    -> AiHealth
  POST /v1/resume/parse           -> ParseResumeResponse        (spec Layer 2A)
  POST /v1/jd/parse               -> ParseJobDescriptionResponse (Module 1 step 1)
  POST /v1/ranking/score          -> CandidateRanking            (Module 1 full pipeline)
  POST /v1/ranking/score-batch    -> {"rankings": [...]}         (Module 1, parallel batch)
  POST /v1/audit/disparity        -> DisparityReport             (Module 1 step 6, pure stats)
  POST /v1/copilot/jd-writer      -> GeneratedJobDescription     (Module 2a)
  POST /v1/copilot/outreach       -> OutreachResult              (Module 2b)
  POST /v1/copilot/chat           -> RecruiterChatResponse       (Module 2c ReAct agent)
  POST /v1/copilot/linkedin/analyze -> AnalyzeLinkedInResponse   (Module 2d)
  POST /v1/interview/analyze      -> AnalyzeInterviewResponse     (Module 3 analysis)
  POST /v1/interview/transcribe   -> TranscribeResponse           (Module 3 WhisperX adapter)
  POST /v1/policy/ingest          -> PolicyIngestResponse         (Module 4 / Layer 2C pipeline)
  POST /v1/embed                  -> EmbedResponse                (Module 4 embeddings)
  POST /v1/chat/answer            -> ChatAnswerResponse           (Module 4 RAG answer)
  POST /v1/analytics/narrative    -> AnalyticsNarrativeResponse    (Module 5e narrative + anomalies)
  POST /v1/analytics/ask          -> AskDataResponse               (Module 5e "Ask your data")
  POST /v1/skills/growth-path     -> GrowthPathResponse            (Module 6a AI growth path)
  POST /v1/skills/build-vs-buy    -> BuildVsBuyResponse            (Module 6c build-vs-buy)
  POST /v1/attrition/score        -> ScoreAttritionResponse         (Module 7 transparent scorer)
  POST /v1/attrition/explain      -> ExplainAttritionResponse       (Module 7 LLM explanation)
  POST /v1/mobility/recommend     -> MobilityRecommendResponse       (Module 8 move recommendation)
  POST /v1/workflows/draft        -> DraftWorkflowResponse            (Module 9 workflow draft authoring)
  POST /v1/assistant/chat         -> AssistantChatAiResponse           (Module 10 agentic HR assistant — role-aware ReAct)

All requests/responses are validated by the Pydantic schemas. When the LLM output
fails validation after retries, the pipeline raises ``HumanReviewNeeded``; we
translate that into HTTP 422 with the payload the API persists as a HumanReviewJob
(prompt standard #5). When self-hosted transcription cannot run (no GPU stack / audio),
the adapter raises ``TranscriptionUnavailable`` which we translate into HTTP 503 so the
caller falls back to the "submit a transcript" path. Privacy/bias guards live inside the
ranker (mask_profile + holistic prompt constraints) and the interview analysis prompt
(privacy guard + evidence-grounded scorecard).
"""

from __future__ import annotations

import structlog
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from . import __version__
from .analytics.ask import answer_data_question
from .analytics.narrative import generate_narrative
from .assistant.agent import run_assistant
from .attrition.explain import explain_attrition
from .attrition.scorer import score_attrition
from .audit.disparity import compute_disparity
from .config import get_settings
from .copilot.chat_agent import run_recruiter_chat
from .copilot.jd_writer import write_job_description
from .copilot.linkedin import analyze_linkedin
from .copilot.outreach import generate_outreach
from .interview.analyze import analyze_interview
from .interview.transcribe import TranscriptionUnavailable, transcribe_interview
from .knowledge.chat import answer_question
from .knowledge.embeddings import embed_documents
from .knowledge.pipeline import ingest_policy
from .mobility.recommend import recommend_move
from .modules.resume_ranker import score_batch, score_candidate_with_reasoning
from .pipelines.jd_parse import parse_job_description
from .pipelines.resume_parse import parse_resume
from .schemas import (
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
    ScoreCandidateRequest,
    TranscribeRequest,
    TranscribeResponse,
    WriteJobDescriptionRequest,
)
from .skills.build_vs_buy import recommend_build_vs_buy
from .skills.growth_path import generate_growth_path
from .validation import HumanReviewNeeded
from .workflows.draft import draft_workflow

log = structlog.get_logger(__name__)

app = FastAPI(
    title="PeopleOS AI Engine",
    version=__version__,
    description="Resume parsing (Layer 2A) + Module 1 candidate ranking.",
)


@app.exception_handler(HumanReviewNeeded)
async def _human_review_handler(_request: object, exc: HumanReviewNeeded) -> JSONResponse:
    """Route exhausted-validation failures to the human review queue (standard #5).

    The body mirrors prisma ``human_review_jobs`` columns so the calling API can
    persist it directly and uses the shared ApiError envelope (common.ts).
    """
    log.warning("human_review_needed", module=exc.module, task=exc.task, reason=exc.reason)
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "HUMAN_REVIEW_NEEDED",
                "message": exc.reason,
                "details": {
                    "module": exc.module,
                    "task": exc.task,
                    "payload": exc.payload,
                },
            }
        },
    )


@app.exception_handler(TranscriptionUnavailable)
async def _transcription_unavailable_handler(
    _request: object, exc: TranscriptionUnavailable
) -> JSONResponse:
    """Map self-hosted-transcription unavailability to HTTP 503 (Module 3).

    Interview audio is transcribed on a self-hosted GPU (WhisperX, NOT OpenAI hosted).
    When that stack/audio is unavailable (this dev/CI environment), we return 503 so the
    caller falls back to the "submit a transcript" path (SubmitTranscriptRequest). Uses
    the shared ApiError envelope (common.ts).
    """
    log.info("transcription_unavailable", reason=exc.reason)
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "code": "TRANSCRIPTION_UNAVAILABLE",
                "message": exc.reason,
                "details": {"fallback": "submit_transcript"},
            }
        },
    )


@app.get("/health", response_model=AiHealth)
async def health() -> AiHealth:
    """Liveness + model identity (AiHealth contract)."""
    settings = get_settings()
    return AiHealth(status="ok", model=settings.model_version, version=__version__)


@app.post("/v1/resume/parse", response_model=ParseResumeResponse)
async def resume_parse(req: ParseResumeRequest) -> ParseResumeResponse:
    """Parse a resume into a structured CandidateProfile (spec Layer 2A)."""
    return await parse_resume(req)


@app.post("/v1/jd/parse", response_model=ParseJobDescriptionResponse)
async def jd_parse(req: ParseJobDescriptionRequest) -> ParseJobDescriptionResponse:
    """Parse a free-text job description into JDStructured (Module 1 step 1)."""
    return await parse_job_description(req)


@app.post("/v1/ranking/score")
async def ranking_score(req: ScoreCandidateRequest) -> dict[str, object]:
    """Score + rank a candidate against a job (Module 1 full pipeline).

    Internal server-to-server response: the CandidateRanking contract PLUS a sibling
    ``reasoning`` field (the chain-of-thought) that the calling API persists to its
    audit-only ``candidate_rankings.reasoning`` column. We deliberately do NOT set a
    ``response_model`` here — FastAPI would filter the sibling out. The API strips
    ``reasoning`` before returning to end clients (prompt standard #3: CoT is never
    shown to the client).
    """
    ranking, reasoning = await score_candidate_with_reasoning(req)
    return {**ranking.model_dump(mode="json"), "reasoning": reasoning}


@app.post("/v1/ranking/score-batch")
async def ranking_score_batch(req: ScoreBatchRequest) -> dict[str, object]:
    """Score a whole applicant batch against one job (Module 1, parallelised).

    Spec Module 1: ranking is "parallelised across applicant batch" with a
    <8s/candidate latency target. ``score_batch`` fans out with bounded concurrency
    (``settings.batch_concurrency``, default 8) and reuses the exact per-candidate
    path. One candidate failing does NOT sink the batch — it is logged and omitted.

    Like the single ``/v1/ranking/score`` endpoint, we deliberately set NO
    ``response_model`` so the per-item sibling ``reasoning`` field (the audit-only
    chain-of-thought) survives the response for the API to persist. The API strips
    ``reasoning`` before returning anything to end clients (prompt standard #3: CoT
    is never shown to the client). The wire shape is ScoreBatchResponse PLUS the
    sibling ``reasoning`` on each ranking item.
    """
    scored = await score_batch(req)
    return {
        "rankings": [
            {**ranking.model_dump(mode="json"), "reasoning": reasoning}
            for ranking, reasoning in scored
        ]
    }


@app.post("/v1/audit/disparity", response_model=DisparityReport)
async def audit_disparity(req: DisparityRequest) -> DisparityReport:
    """Adverse-impact / disparity audit over scored candidates (Module 1 step 6).

    Pure statistics, NO LLM (spec step 6 + the ethics checklist "Disparity test"):
    per-group selection rate + mean score, the EEOC 4/5ths adverse-impact ratio, the
    4/5ths-violation flag, and the >10pp disproportionate-flag. The org-supplied
    group labels are used only for this computation and are never persisted here.
    """
    return compute_disparity(req)


# ═══ Module 2 — Recruiter Copilot ═════════════════════════════════════════════
@app.post("/v1/copilot/jd-writer", response_model=GeneratedJobDescription)
async def copilot_jd_writer(req: WriteJobDescriptionRequest) -> GeneratedJobDescription:
    """Generate an inclusive, tone-matched job description (Module 2a).

    Uses orgContext for tone and priorJdExamples as tone-matched few-shot, produces
    the section content + assembled jdText, and runs an inclusive-language pass
    (InclusiveLanguageReport + biasCheck). Offline-capable (clearly-marked fallback).
    """
    return await write_job_description(req)


@app.post("/v1/copilot/outreach", response_model=OutreachResult)
async def copilot_outreach(req: GenerateOutreachRequest) -> OutreachResult:
    """Generate personalised candidate outreach (Module 2b).

    Personalised to the real candidate's concrete profile (NOT bias-masked — the
    message is to the real person). One variant per requested tone, an InMail body,
    extra subjectVariants for A/B testing, and a biasCheck. Offline-capable.
    """
    return await generate_outreach(req)


@app.post("/v1/copilot/chat", response_model=RecruiterChatResponse)
async def copilot_chat(req: RecruiterChatRequest) -> RecruiterChatResponse:
    """Recruiter chat assistant — bounded ReAct agent (Module 2c).

    Native Anthropic tool-use loop (max ``chat_max_iterations``, default 8). Tools
    call back to the API's internal copilot endpoints (tenant-scoped by the request's
    orgId, never the model). Returns answer + a tool trace (no raw data dumps).
    Offline (no ANTHROPIC_API_KEY): a clearly-marked stub answer.
    """
    return await run_recruiter_chat(req)


@app.post("/v1/copilot/linkedin/analyze", response_model=AnalyzeLinkedInResponse)
async def copilot_linkedin_analyze(req: AnalyzeLinkedInRequest) -> AnalyzeLinkedInResponse:
    """Analyse a consented scraped LinkedIn profile + benchmark vs open roles (2d).

    Converts the scraped profile into a structured CandidateProfile, matches it
    against each supplied role with the EXISTING Module 1 skill_match, and produces an
    advisory summary (offline-capable) + biasCheck. Consent is enforced by the schema.
    """
    return await analyze_linkedin(req)


# ═══ Module 3 — Interview Intelligence & Summaries ════════════════════════════
@app.post("/v1/interview/analyze", response_model=AnalyzeInterviewResponse)
async def interview_analyze(req: AnalyzeInterviewRequest) -> AnalyzeInterviewResponse:
    """Analyse a diarised interview transcript (Module 3 — the 4 analysis steps).

    One coherent LLM pass produces: per-Q/A competency evidence with per-dimension STAR
    scores; an evidence-grounded scorecard draft (every CompetencyScore carries a
    VERBATIM transcript quote — prompt standard #2, no score without evidence) with an
    overall recommendation/confidence/keyReasons; a 3-paragraph executive summary; and
    calibration flags (LEADING_QUESTION / ILLEGAL_QUESTION grounded in a transcript
    quote — panel SCORE_DIVERGENCE is API-computed). PRIVACY GUARD: only professional
    competencies are evaluated; personal disclosures are never repeated. Offline
    (no ANTHROPIC_API_KEY): a clearly-marked deterministic heuristic analysis.
    """
    return await analyze_interview(req)


@app.post("/v1/interview/transcribe", response_model=TranscribeResponse)
async def interview_transcribe(req: TranscribeRequest) -> TranscribeResponse:
    """Transcribe + diarise an interview recording (Module 3 — self-hosted WhisperX).

    Self-hosted WhisperX large-v3 + speaker diarisation on a GPU host — NEVER OpenAI
    hosted Whisper (data privacy; interview content is highly sensitive). When the GPU
    stack / audio is unavailable (this environment), raises TranscriptionUnavailable,
    which the handler maps to HTTP 503 so the caller submits a transcript instead. We
    never fabricate a transcript.
    """
    return await transcribe_interview(req)


# ═══ Module 4 — Company knowledge base + Employee HR Chatbot (RAG) ════════════
@app.post("/v1/policy/ingest", response_model=PolicyIngestResponse)
async def policy_ingest(req: PolicyIngestRequest) -> PolicyIngestResponse:
    """Ingest a policy document into semantic chunks + embeddings (spec Layer 2C).

    Structural parse (H1/H2/H3 section tree) -> segment by section with a sectionPath ->
    SEMANTIC chunking (split at section/paragraph boundaries, max ~1200 tokens, ~15%
    overlap) emitting DocumentChunkData (sectionPath, char offsets, pageNumber null for
    text, tokenCount, EMBEDDING) -> SimHash fingerprint of the whole doc for dedup/
    versioning. The API persists the chunks (DocumentChunk) + simhash (PolicyDocument).
    Offline (no OPENAI_API_KEY): chunk embeddings use the deterministic fallback and
    modelVersion is suffixed +offline_fallback.
    """
    return await ingest_policy(req)


@app.post("/v1/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    """Embed a batch of texts at the fixed RAG dimensionality (Module 4 embeddings).

    text-embedding-3-large via the OpenAI SDK with the ``dimensions`` param pinned to
    settings.embedding_dim (default 1536) so ingest-time and query-time vectors are always
    the same length (cosine retrieval requires it). The SAME embed function backs the
    document pipeline. Offline (no OPENAI_API_KEY): a deterministic unit vector of the same
    dim from token hashing, with the model id suffixed +offline_fallback.
    """
    batch = await embed_documents(req.texts)
    return EmbedResponse(embeddings=batch.vectors, model=batch.model, dim=batch.dim)


@app.post("/v1/chat/answer", response_model=ChatAnswerResponse)
async def chat_answer(req: ChatAnswerRequest) -> ChatAnswerResponse:
    """Generate a grounded RAG answer to an employee HR question (spec Module 4 step 3).

    Answers ONLY from the provided candidateChunks (the API does retrieval). If the answer
    is not in the chunks, it does NOT invent policy — it sets low confidence and escalates.
    Every claim cites a policy (Citation: docTitle + sectionPath + effectiveDate, docId
    echoed from the chunk). Sensitive topics (termination, harassment, salary dispute,
    discrimination) FORCE escalate=true + sensitiveTopic and hand off to a human. Personalises
    with the employee's own context without exposing other employees' data. Produces a topic
    label (analytics) + biasCheck. Pydantic-validated with the retry/human-review path;
    offline (no ANTHROPIC_API_KEY): a clearly-marked extractive fallback that always escalates.
    """
    return await answer_question(req)


# ═══ Module 5 — Workforce Analytics Dashboard (5e AI narrative + Ask your data) ═══
@app.post("/v1/analytics/narrative", response_model=AnalyticsNarrativeResponse)
async def analytics_narrative(req: AnalyticsNarrativeRequest) -> AnalyticsNarrativeResponse:
    """Executive workforce narrative + anomaly detection over a metrics snapshot (5e).

    The API computes DashboardMetrics from Postgres (prod: Snowflake + DBT) and supplies
    them here. Produces a headline, a 3-paragraph executive narrative naming the period's
    most important people metrics, a keyMetrics list, and anomalies (each a FlagSeverity:
    WIDE/NARROW span of control, SLA breaches, low conversion, etc.). GROUNDED ONLY in the
    supplied metrics — never invents or extrapolates, never queries data or writes SQL.
    Offline (no ANTHROPIC_API_KEY): a clearly-marked deterministic narrative templated from
    the metrics + rule-based anomalies.
    """
    return await generate_narrative(req)


@app.post("/v1/analytics/ask", response_model=AskDataResponse)
async def analytics_ask(req: AskDataRequest) -> AskDataResponse:
    """"Ask your data" — answer a NL question using ONLY the supplied metrics (5e).

    Reads the fixed DashboardMetrics snapshot (the API supplies it), answers the question,
    lists which metric keys it drew on (usedMetrics), optionally returns a ChartSpec
    (BAR/LINE/PIE built from the metrics) when a chart aids the answer, and reports a
    confidence. No SQL, no external data, no fabrication — if the needed metric is not in
    the snapshot it says so plainly and sets confidence "low". Offline (no
    ANTHROPIC_API_KEY): a deterministic keyword -> metric lookup with a templated answer.
    """
    return await answer_data_question(req)


# ═══ Module 6 — Employee Skill Graph (6a AI growth path + 6c build-vs-buy) ═════════
@app.post("/v1/skills/growth-path", response_model=GrowthPathResponse)
async def skills_growth_path(req: GrowthPathRequest) -> GrowthPathResponse:
    """AI growth path to a target role over the employee skill graph (spec Module 6a).

    Given the employee's current skills + the target role's required skills (+ an optional
    skill catalog), computes stepsAway = the count of target-required skills the employee
    LACKS and recommends those missing skills with a short why + a suggested training
    (a catalog match where one exists, else a generic suggestion). GROUNDED in the supplied
    skills only — stepsAway is the exact set difference and recommendations are forced onto
    that set, so it never claims a skill the employee already holds or one the role does not
    require, and never references another employee. Bias guard (standard #4): growth is
    based ONLY on the skill gap, never a protected attribute; the output carries a biasCheck.
    Offline (no ANTHROPIC_API_KEY): a deterministic set-difference path + templated recs.
    """
    return await generate_growth_path(req)


@app.post("/v1/skills/build-vs-buy", response_model=BuildVsBuyResponse)
async def skills_build_vs_buy(req: BuildVsBuyRequest) -> BuildVsBuyResponse:
    """"Build vs Buy" recommender for a skill gap (spec Module 6c).

    Given a skill with its currentSupply, demand, and trainableInternally counts, returns
    BUILD (train internally), BUY (hire), or HYBRID from a deterministic supply-vs-demand
    rule (gap = max(0, demand - supply); BUILD if the trainable pool covers the gap, BUY if
    no one is trainable, else HYBRID) plus a concise rationale grounded in the supplied
    numbers. The deterministic rule is the source of truth for the verdict (reproducible /
    auditable); the LLM supplies only the prose. Offline (no ANTHROPIC_API_KEY): the same
    rule + a templated rationale.
    """
    return await recommend_build_vs_buy(req)


# ═══ Module 7 — Attrition Prediction Engine (transparent scorer + LLM explanation) ═════
@app.post("/v1/attrition/score", response_model=ScoreAttritionResponse)
async def attrition_score(req: ScoreAttritionRequest) -> ScoreAttritionResponse:
    """Score a batch of employees' attrition risk (spec Module 7 — the ML model + SHAP).

    A TRANSPARENT cold-start logistic model (the dev/offline default — NO network, NO keys):
    each AttritionFeatures field is normalised to a [0,1]-ish signal, combined with
    documented prior weights via a sigmoid into riskScore in [0,1], then tiered
    (CRITICAL >= 0.75, HIGH >= 0.5, MEDIUM >= 0.25, else LOW). Because the model is linear in
    its contributions, each feature's contribution (weight * normalised value) IS a faithful
    SHAP value, so shapValues + topDrivers are EXACT. A guarded adapter swaps in XGBoost +
    tree SHAP (Platt-calibrated, MLflow-deployed, >=200 training events) when its artifact is
    present (the prod path). The model uses ONLY the provided features — NEVER a protected
    attribute — and treats missing (null) features as neutral (never imputed as risk). The
    score is ADVISORY only; governance (role-gated views, opt-out, the never-shown-to-the-
    employee rule) is enforced by the API, not here. No LLM is involved.
    """
    return score_attrition(req)


@app.post("/v1/attrition/explain", response_model=ExplainAttritionResponse)
async def attrition_explain(req: ExplainAttritionRequest) -> ExplainAttritionResponse:
    """Explain an attrition-risk flag for a manager (spec Module 7 — LLM explanation layer).

    GROUNDED ONLY in the supplied topDrivers + risk tier + a NON-PII employee context (the
    raw score and feature values are never passed to the prompt, so the narrative cannot leak
    them — managers see tier + recommendation only). Produces a supportive, manager-facing
    narrative + concrete recommendedActions, always framed as ADVISORY (no automated HR
    action). Never speculates beyond the drivers, never infers personal circumstances
    (privacy guard #7), never references a protected attribute (bias guard #4 — the biasCheck
    is forced empty). Offline (no ANTHROPIC_API_KEY): a deterministic templated narrative
    built from the same drivers, clearly marked.
    """
    return await explain_attrition(req)


# ═══ Module 8 — Internal Talent Marketplace / Internal Mobility (move recommendation) ═══
@app.post("/v1/mobility/recommend", response_model=MobilityRecommendResponse)
async def mobility_recommend(req: MobilityRecommendRequest) -> MobilityRecommendResponse:
    """Recommend an internal move + a development plan (spec Module 8 internal mobility).

    The matching is SKILL-GRAPH driven and computed IN THE NODE API (reusing the Module 6
    skillGap primitive → matchScore = coverage + readiness + matched/missing skills); this
    surface only narrates and plans over that result. Produces a concise advisory FIT
    SUMMARY for the internal move and a DEVELOPMENT PLAN — one DevelopmentStep (skill +
    concrete action + optional resource) per MISSING skill. GROUNDED ONLY in the supplied
    matched/missing skills: the plan is forced to cover EXACTLY the missing skills (invented
    or already-matched skills are dropped, omitted missing skills back-filled), so it never
    invents a skill the employee has or needs. It never references another employee
    (privacy guard #7) or a protected attribute (bias guard #4 — the biasCheck is forced
    clean); the raw match score is never passed to the prompt so the text cannot leak it.
    Offline (no ANTHROPIC_API_KEY): a deterministic templated fit summary + one step per
    missing skill, clearly marked.
    """
    return await recommend_move(req)


# ═══ Module 9 — Workflow Automation Engine (AI draft authoring) ════════════════════════
@app.post("/v1/workflows/draft", response_model=DraftWorkflowResponse)
async def workflows_draft(req: DraftWorkflowRequest) -> DraftWorkflowResponse:
    """Draft a runnable HR workflow from a free-text description (spec Module 9).

    Turns the NL description into a workflow definition — a name + trigger (+ eventType) + an
    ORDERED sequence of typed WorkflowStep objects (TASK / APPROVAL / NOTIFICATION / AI_TASK /
    TIMER / BRANCH) with realistic assigneeRole + slaHours on the human steps and a linear
    next-chain (the last step's next is null). GROUNDED in the allowed StepType / role
    vocabularies and REPAIRED in code (standards #2/#5): every step type is a valid StepType,
    every assigneeRole is a valid role (invalid dropped / human steps defaulted), step ids are
    unique, and the next-chain is well-formed (no dangling next; terminal end). The draft is a
    starting point a human reviews + saves in the durable execution engine; it is never
    auto-deployed. Offline (no ANTHROPIC_API_KEY): a clearly-marked deterministic 3-4 step
    template (APPROVAL -> TASK -> NOTIFICATION) derived from the description.
    """
    return await draft_workflow(req)


# ═══ Module 10 — Agentic HR Assistant (the capstone: role-aware ReAct orchestrator) ═════
@app.post("/v1/assistant/chat", response_model=AssistantChatAiResponse)
async def assistant_chat(req: AssistantChatAiRequest) -> AssistantChatAiResponse:
    """Agentic HR Assistant — the org-wide, ROLE-AWARE ReAct orchestrator (spec Module 10).

    A bounded reason -> act -> observe loop (max ``chat_max_iterations``, default 8) over a
    ROLE-FILTERED tool registry: the model only ever SEES the tools ``req.context.role`` may
    use. Each tool dispatches to the Node API's secret-authed ``/internal/assistant/tool``,
    which RE-ENFORCES tenancy + per-tool role governance from the TRUSTED AssistantContext —
    NEVER from the agent's tool arguments — so the agent can never become a confused deputy.
    Identity (orgId/userId/role) is attached to every dispatch PROGRAMMATICALLY; the LLM never
    sees it and tool args can never override it. WRITE/action tools (raise_hr_ticket,
    start_workflow, generate_outreach) are audited and the agent confirms intent first.

    Returns the reply (with <thinking> CoT stripped, standard #3) + a ToolCallTrace per call
    (short, non-sensitive summaries only — never raw output) + role-aware suggestedActions.
    Offline (no ANTHROPIC_API_KEY): a graceful, clearly-marked tool-free reply — never crashes.
    """
    return await run_assistant(req)
