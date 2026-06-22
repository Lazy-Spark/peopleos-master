# @peopleos/api

The PeopleOS REST API — **Node 20 + Fastify**, TypeScript (strict), Prisma, Zod
validation via `fastify-type-provider-zod`, OpenAPI 3.1 (`/docs`), Clerk auth, and
pino logging. All business routes are versioned under `/api/v1` and tenant-scoped
via PostgreSQL Row-Level Security.

## What's here

```
src/
  env.ts              Zod-validated process.env (fails fast at boot)
  db.ts               Prisma client on DATABASE_URL_APP + withTenant() RLS helper
  app.ts              buildApp(): plugins + routes + ZodTypeProvider + ApiError handler
  server.ts           HTTP listener on API_HOST/API_PORT (+ graceful shutdown)
  worker.ts           BullMQ worker process: consumes the `ranking` queue → rankApplication;
                      ALSO runs the periodic sweeps: retention purge (Module 3) + the Module 9
                      workflow tick (jobs/workflowTick.ts — fire TIMERs / SLA-escalate / start
                      due SCHEDULED definitions; owner-discover, per-org withTenant-process)
  plugins/
    auth.ts           Clerk JWT verification → request.auth { userId, orgId, role }
                      (DEV-ONLY X-Org-Id header fallback when NODE_ENV !== production)
    tenancy.ts        requireTenant preHandler: ensures a valid uuid orgId is present
    swagger.ts        OpenAPI 3.1 + Swagger UI at /docs
  lib/
    aiClient.ts       Typed client for services/ai (undici), Zod-validated I/O, 30s timeout
                      score / scoreWithReasoning / scoreBatch / disparity / parse* / health
                      + Module 2: writeJd / outreach / chat / analyzeLinkedIn
                      + Module 3: transcribeInterview / analyzeInterview
                      + Module 4: ingestPolicy / embed / chatAnswer
                      + Module 5: narrative / askData
                      + Module 6: growthPath / buildVsBuy
                      + Module 7: scoreAttrition / explainAttrition
                      + Module 8: recommendMove
                      + Module 9: draftWorkflow
    analytics.ts      Module 5 — computeDashboard(tx, orgId): DashboardMetrics from Postgres
                      (5a recruiting funnel, 5b workforce composition — internalMobilityRate
                      wired to Module 8 InternalApplication, 5c engagement/retention wired to
                      Module 7 attrition, 5d skills wired to Module 6)
    mobilityMatch.ts  Module 8 — skill-graph-driven matching primitives (all take the tenant
                      tx): recommendedRoles / internalCandidates / successionPlan /
                      recommendedGigs / mobilityAnalytics (reuse skillGraph.skillGap; flight
                      risk is the Module 7 attrition TIER only, ADMIN/HRBP viewers only)
    attritionFeatures.ts  Module 7 — computeFeatures(tx, employee, peers, now): the available
                      AttritionFeatures (tenure/perf/team/skill signals; never a protected attr)
    attritionScores.ts    Module 7 — loadLatestScores / countByTier / isRegrettable /
                      riskTierToRankingTier (shared by the routes + the 5c dashboard wiring)
    audit.ts          writeAudit(tx, …) — AuditLog insert inside the tenant transaction
    errors.ts         HttpError + notFound/conflict/badRequest/forbidden helpers
    orgContext.ts     buildOrgContext(org, role) — prompt-standard-#1 OrgContext from Organisation.settings
    workflowEngine.ts Module 9 — the DURABLE DB-persisted workflow state machine (the dev engine):
                      startInstance / advance / completeTask / processTimersAndSla / emitEvent /
                      cancelInstance + evaluateCondition (the SAFE field/op/value branch comparator —
                      NO eval/Function). Loop-safe (iteration cap + visited-step guard → a cyclic
                      BRANCH FAILs, never hangs); AI-resilient (an AI_TASK never blocks the walk).
                      Temporal is the documented prod substrate (adapter notes in-file).
    serialize.ts      Prisma row → wire contract (@peopleos/schemas) serializers
                      + Module 3: serializeScorecard (InterviewScorecard) / serializeInterview
                      + Module 4: serializePolicyDocument / serializeChatMessage / serializeHrTicket
                      + Module 9: serializeWorkflowDefinition / Instance / Task + parseWorkflowSteps
    retrieval.ts      Module 4 — hybrid (dense cosine + lexical) RRF retrieval over ACTIVE chunks
    chatMemory.ts     Module 4 — Redis sliding-window chat memory (chat:{sessionId}, 10 turns, 24h TTL)
    internalSecret.ts Shared constant-time x-internal-secret guard (Module 2c + Module 10 routers; fail-closed)
    assistantTools.ts Module 10 — server-side tool registry: TOOL_ROLES allowlist + dispatchAssistantTool
                      (routes each permitted tool to its module lib + re-runs that module's governance from
                      the trusted context.role; WRITE tools audited; errors caught → ok:false, never crash)
    transcriptStore.ts  Module 3 — encrypted S3 object store for transcripts (put/get/delete);
                      SSE-KMS (prod) / AES-256 (dev/MinIO); NEVER a plaintext DB column
  services/
    ranking.ts        Shared Module 1 ranking service: rankApplication + rankJobPipeline
                      (persist ranking + audit-only CoT, update Application.aiRanking, audit)
  queue/
    connection.ts     Shared ioredis connection for BullMQ (maxRetriesPerRequest: null)
    rankingQueue.ts   Queue 'ranking' + enqueueRanking({ orgId, applicationId })
  routes/
    health.ts         GET /health (+ DB and AI-service reachability)
    jobs.ts           GET/POST /api/v1/jobs, GET /api/v1/jobs/:id,
                      GET /api/v1/jobs/:id/applications, POST /api/v1/jobs/:id/rank
    candidates.ts     GET/POST /api/v1/candidates, GET /api/v1/candidates/:id
    applications.ts   GET/POST /api/v1/applications, PATCH …/:id/stage
                      (POST also enqueues the ranking auto-trigger, best-effort)
    rankings.ts       POST /api/v1/applications/:id/rank  (Module 1 — AI screening)
    audit.ts          POST /api/v1/jobs/:id/bias-audit    (EEOC 4/5ths disparity, ADMIN/HRBP)
    copilot.ts        Module 2 (Recruiter Copilot) — tenant-scoped under /api/v1:
                      POST /api/v1/copilot/jd                         (2a JD writer)
                      POST /api/v1/applications/:id/outreach          (2b outreach)
                      POST /api/v1/copilot/chat                       (2c ReAct chat)
                      POST /api/v1/copilot/linkedin/analyze           (2d analyse)
                      POST /api/v1/copilot/linkedin/add-to-pool       (2d add to pool)
    interviews.ts     Module 3 (Interview Intelligence) — tenant-scoped under /api/v1:
                      POST   /api/v1/interviews                       (create; consent REQUIRED)
                      POST   /api/v1/interviews/:id/transcript        (submit transcript → S3)
                      POST   /api/v1/interviews/:id/transcribe        (WhisperX → S3)
                      POST   /api/v1/interviews/:id/analyze           (4-step AI analysis)
                      POST   /api/v1/scorecards/:id/submit            (reviewer's final scores)
                      GET    /api/v1/applications/:id/calibration     (panel divergence + AI flags)
                      DELETE /api/v1/interviews/:id/transcript        (DSAR erase; idempotent)
    policies.ts       Module 4 (Knowledge base / Layer 2C) — tenant-scoped under /api/v1:
                      POST   /api/v1/policies                         (ingest: chunk+embed+version; ADMIN/HRBP)
                      GET    /api/v1/policies                         (list ACTIVE documents)
                      DELETE /api/v1/policies/:id                     (archive + chunks inactive; ADMIN/HRBP)
    hrChat.ts         Module 4 (Employee HR Chatbot — RAG) — tenant-scoped under /api/v1:
                      POST  /api/v1/hr-chat/ask                       (the grounded RAG loop)
                      POST  /api/v1/hr-chat/messages/:id/feedback     (thumbs up/down)
                      GET   /api/v1/hr-chat/sessions/:id              (durable transcript)
                      GET   /api/v1/hr-tickets                        (list escalations)
                      PATCH /api/v1/hr-tickets/:id                    (triage status/assignee; ADMIN/HRBP)
    analytics.ts      Module 5 (Workforce Analytics) — tenant-scoped under /api/v1,
                      leadership-only (ADMIN/HRBP/MANAGER):
                      GET  /api/v1/analytics/dashboard                (DashboardMetrics 5a-5d)
                      POST /api/v1/analytics/narrative                (5e AI narrative + anomalies)
                      POST /api/v1/analytics/ask                      (5e "Ask your data" NL query)
    skills.ts         Module 6 (Employee Skill Graph) — tenant-scoped under /api/v1:
                      GET  /api/v1/skills                             (skill catalog)
                      POST /api/v1/skills                             (create skill — ADMIN/HRBP)
                      GET  /api/v1/employees/:id/skills               (EmployeeSkillProfile 6a)
                      POST /api/v1/employees/:id/skills               (self-report; SELF_REPORTED 0.5)
                      PATCH /api/v1/skill-records/:id/verify          (6d MANAGER_VERIFIED 0.8)
                      GET  /api/v1/skills/who-has/:skillId            (WhoHasSkillResult)
                      GET  /api/v1/employees/:id/skill-gap            (gap + AI growth path 6a)
                      GET  /api/v1/skills/team-map?managerId=         (TeamSkillMap 6b)
                      GET  /api/v1/skills/inventory                   (SkillInventory 6c)
                      GET  /api/v1/skills/build-vs-buy?skillId=       (BuildVsBuyResponse 6c)
    attrition.ts      Module 7 (Attrition Prediction) — tenant-scoped under /api/v1:
                      POST  /api/v1/attrition/score                   (run scoring; ADMIN/HRBP)
                      GET   /api/v1/attrition/summary                 (tiers+heatmap; ADMIN/HRBP/MANAGER)
                      GET   /api/v1/employees/:id/attrition           (full/manager/403 by role)
                      PATCH /api/v1/employees/:id/attrition-opt-out   (right to not be profiled)
                      POST  /api/v1/attrition/bias-audit              (tier disparity; ADMIN/HRBP)
    mobility.ts       Module 8 (Internal Talent Marketplace) — tenant-scoped under /api/v1:
                      GET   /api/v1/employees/:id/recommended-roles    (RecommendedRoles 8a)
                      POST  /api/v1/internal-applications              (apply for SELF 8a)
                      GET   /api/v1/internal-applications              (InternalApplicationView[] 8a)
                      PATCH /api/v1/internal-applications/:id          (pipeline; ADMIN/HRBP/RECRUITER)
                      GET   /api/v1/jobs/:id/internal-candidates       (RoleMatchResult 8b)
                      GET   /api/v1/jobs/:id/succession                (SuccessionPlan 8d; ADMIN/HRBP)
                      GET   /api/v1/mobility/analytics                 (MobilityAnalytics; ADMIN/HRBP)
                      GET   /api/v1/gigs                               (Gig[] 8c)
                      POST  /api/v1/gigs                               (create; ADMIN/HRBP/MANAGER 8c)
                      POST  /api/v1/gigs/:id/interest                  (express interest for SELF 8c)
                      GET   /api/v1/employees/:id/recommended-gigs     (RecommendedGigs 8c)
                      GET   /api/v1/employees/:id/mobility-fit?jobOpeningId=  (match + AI move rec)
    workflow.ts       Module 9 (Workflow Automation) — tenant-scoped under /api/v1:
                      GET   /api/v1/workflow-definitions               (WorkflowDefinition[])
                      GET   /api/v1/workflow-definitions/:id           (WorkflowDefinition)
                      POST  /api/v1/workflow-definitions               (create; ADMIN/HRBP — DAG validated)
                      POST  /api/v1/workflow-definitions/draft         (AI draft, NOT persisted; ADMIN/HRBP)
                      POST  /api/v1/workflow-definitions/:id/start     (start; ADMIN/HRBP/MANAGER)
                      GET   /api/v1/workflow-instances                 (WorkflowInstanceSummary[])
                      GET   /api/v1/workflow-instances/:id             (WorkflowInstanceDetail + tasks)
                      POST  /api/v1/workflow-instances/:id/cancel      (cancel; ADMIN/HRBP/MANAGER)
                      GET   /api/v1/workflow-tasks?mine=1              (the caller's task inbox)
                      POST  /api/v1/workflow-tasks/:id/complete        (assignee/role/ADMIN/HRBP only)
                      POST  /api/v1/workflow-events                    (emit event → start matches; ADMIN/HRBP)
                      GET   /api/v1/workflow-monitor                   (WorkflowMonitor; ADMIN/HRBP)
    assistant.ts      Module 10 (Agentic HR Assistant) — tenant-scoped under /api/v1:
                      POST  /api/v1/assistant/chat                     (one agent turn; own session; audited)
                      GET   /api/v1/assistant/sessions                 (caller's own AssistantSessionSummary[])
                      GET   /api/v1/assistant/sessions/:id             (own AssistantSessionDetail; 404 otherwise)
    internal.ts       Module 2c INTERNAL tool router — root-mounted, OUTSIDE /api/v1,
                      NO Clerk/tenancy; x-internal-secret guarded (see trust boundary):
                      POST /internal/copilot/search-candidates
                      POST /internal/copilot/pipeline-stats
                      POST /internal/copilot/candidate
    internalAssistant.ts  Module 10 INTERNAL tool dispatcher — root-mounted, OUTSIDE /api/v1,
                      NO Clerk/tenancy; same x-internal-secret guard (fail-closed):
                      POST /internal/assistant/tool   (re-derives the role allowlist from the
                      trusted context.role + re-runs each module's governance; ignores any
                      identity in args; a disallowed tool returns ok:false/"forbidden")
```

## Module 1 — AI Resume Screening & Candidate Ranking

The ranking logic lives in **`src/services/ranking.ts`** and is shared by three callers
so they behave identically (persist the ranking incl. the audit-only chain-of-thought,
update `Application.aiRanking`, write the `AuditLog`, return CoT-free output):

| Caller | Entry | What it does |
| ------ | ----- | ------------ |
| Single rank (HTTP) | `POST /api/v1/applications/:id/rank` | `rankApplication` — a `skipped` result (no parsed profile) → 400 |
| Batch rank (HTTP) | `POST /api/v1/jobs/:id/rank?stages=SCREENING,APPLIED` | `rankJobPipeline` — one `ScoreBatchRequest`, persists each ranking, returns `RankJobResponse` sorted best-first + skipped |
| Auto-trigger (worker) | BullMQ `ranking` queue | `rankApplication` for each applied candidate; a `skipped` result is logged, **not** retried |

**Chain-of-thought is audit-only** (prompt standard #3): the AI service emits a sibling
`reasoning` per ranking; `aiClient.scoreWithReasoning` / `aiClient.scoreBatch` extract it
from the RAW body (aligned by index for the batch) and the service persists it to
`candidate_rankings.reasoning`. The `CandidateRanking` contract has no `reasoning` field,
so it is structurally impossible to return it to a client.

### Auto-trigger worker (BullMQ + Redis)

When a candidate applies (`POST /api/v1/applications`), after the tenant transaction
commits the route **best-effort** enqueues `{ orgId, applicationId }` onto the `ranking`
queue (a Redis/enqueue failure never fails the create — it is caught and logged). Run the
worker as a **separate process** so AI scoring (up to ~8s/candidate) never blocks the HTTP
path:

```bash
pnpm --filter @peopleos/api worker          # dev:  tsx watch src/worker.ts
pnpm --filter @peopleos/api worker:start     # prod: node dist/worker.js (after build)
```

The worker validates each job payload, runs `rankApplication`, logs a `skipped` result
(candidate has no parsed profile yet) and returns normally so it is never retried; a
missing application is likewise non-retryable. Any transient failure (AI 502/timeout, DB
blip) throws so BullMQ retries with exponential backoff. Shutdown on SIGINT/SIGTERM drains
in-flight jobs before closing Redis + Prisma.

### Bias audit (EEOC 4/5ths)

`POST /api/v1/jobs/:id/bias-audit` (ADMIN/HRBP only — 403 otherwise) takes a
`JobBiasAuditRequest` `{ demographics: [{ candidateId, group }], selectionTiers? }`. It
joins the job's persisted rankings (latest per candidate) with the provided demographic
mapping **in memory**, calls `aiClient.disparity`, and returns a `JobBiasAuditResponse`
`{ jobId, report, unmatched }`. PeopleOS **never stores protected attributes** — the
mapping arrives only in the request body and is discarded after the computation (the audit
log records only aggregate counts, never per-candidate group assignments).

## Module 2 — Recruiter Copilot

A context-aware AI assistant embedded in the recruiter workspace. The API owns the
DB access + multi-tenancy + privacy/consent/audit; the generation itself happens in
`services/ai` (primary LLM `claude-sonnet-4-6`, the 7 prompt-engineering standards
applied there). Each endpoint loads the org/job/candidate context under RLS, calls
the matching `aiClient` method (Zod-validated request **and** response), and returns
the frozen `@peopleos/schemas` contract.

| Sub-feature | Endpoint | What the API does |
| ----------- | -------- | ----------------- |
| **2a JD Writer** | `POST /api/v1/copilot/jd` | Loads `OrgContext` + the org's recent `jdText`s (≤5) as **tone-matched few-shot** `priorJdExamples`, calls `aiClient.writeJd` → `GeneratedJobDescription` (with inclusive-language report + `biasCheck`). |
| **2b Outreach** | `POST /api/v1/applications/:id/outreach` | Loads application + candidate + job + org + the **acting recruiter's name**; a candidate with **no parsed profile → 400** (outreach references concrete résumé detail). Calls `aiClient.outreach` → `OutreachResult` (warm/formal/brief + InMail + subject A/B). Writes an `AuditLog` (no message bodies in the payload). |
| **2c Chat** | `POST /api/v1/copilot/chat` | Forwards `{ orgId: SESSION orgId, userRole: tenant().role, messages, jobId }` to `aiClient.chat`. **`orgId` always comes from the authenticated session — never the body.** The agent's tools call back into the internal router (below). |
| **2d LinkedIn analyse** | `POST /api/v1/copilot/linkedin/analyze` | **Consent required** (`consent !== true → 400`). Loads the org's **OPEN** roles as `roles[]` (the AI service can't query the DB), calls `aiClient.analyzeLinkedIn` → `AnalyzeLinkedInResponse`. Read-only (does not persist a candidate). |
| **2d Add to pool** | `POST /api/v1/copilot/linkedin/add-to-pool` | **Consent required**. Maps the scraped profile → `CandidateProfile` and creates a `Candidate` (`source LINKEDIN`, `orgId` set so RLS `WITH CHECK` passes). Audited. Returns `{ candidateId, createdAt }`. |

Bias/privacy notes: outreach (2b) and analyse (2d) carry a `biasCheck` from the AI
service. Outreach intentionally is **not** masked (unlike Module 1 scoring) — it
personalises to the real person by design. LinkedIn scraping is consent-gated
end-to-end (the `AnalyzeLinkedInRequest` / `AddToPoolRequest` contracts use
`consent: literal(true)`; the routes also reject early with a clean 400).

### Internal tool router + trust boundary (`src/routes/internal.ts`)

The Module 2c chat agent (a LangGraph ReAct agent in `services/ai`) needs to call
back into the API to run its tools while a recruiter chats. Those calls hit
**`/internal/copilot/{search-candidates,pipeline-stats,candidate}`**, which are:

- **mounted at the ROOT, OUTSIDE `/api/v1`**, with **NO Clerk/tenancy preHandler** —
  the only non-tenant-preHandler business routes in the API;
- authenticated by a **shared secret**: the caller must send
  `x-internal-secret: <AI_SERVICE_SECRET>`, compared in **constant time**
  (`crypto.timingSafeEqual`); a mismatch/absence → `401`. **If `AI_SERVICE_SECRET`
  is unset, the router refuses ALL internal calls (fail-closed)** — in production
  `env.ts` makes the secret mandatory at boot;
- **tenant-scoped by the `orgId` in the request body** (`Tool*Request`). That `orgId`
  was set by the API on the authenticated `/api/v1/copilot/chat` request (from the
  end user's Clerk session) and propagated to the AI service, which echoes it back.
  Every handler runs inside `withTenant(orgId, …)` so RLS scopes it exactly as a
  first-party request would. **The secret authenticates the *service*; the body's
  `orgId` selects the tenant the service was authorised for.**

Network posture: bind `/internal/*` only on the internal network / service mesh —
never expose it on the public ingress. The `x-internal-secret` header is redacted
from request logs.

Tools: `search-candidates` (substring search over name/headline/skills in the org;
optional `jobId` narrows to that pipeline) · `pipeline-stats` (stage counts + funnel
conversion rates + `daysOpen` from the job's `createdAt`/`closedAt`) · `candidate`
(the candidate's `CandidateProfile` + latest ranking tier). These are advisory reads;
no writes happen through the internal router.

## Module 3 — Interview Intelligence & Summaries

Turns a recorded interview into a structured, evidence-grounded scorecard. The API
owns DB access + multi-tenancy + **privacy/consent/retention/DSAR** + audit; the AI
generation (the 4 analysis steps) and self-hosted **WhisperX** transcription live in
`services/ai` (primary LLM `claude-sonnet-4-6`, the 7 prompt-engineering standards
applied there). Every endpoint is tenant-scoped (`requireTenant` + `withTenant`).

| Endpoint | What the API does |
| -------- | ----------------- |
| `POST /api/v1/interviews` | Create a `SCHEDULED` interview. **`consentObtained` MUST be literal `true`** (the `CreateInterviewRequest` contract enforces it; a non-true value is a `400`). Sets `transcriptStatus=PENDING` and `transcriptRetentionDeleteAt = now + the org's retention days` (`Organisation.settings.transcriptRetentionDays`, default **90**). The application must belong to the caller's org. Audited. |
| `POST /api/v1/interviews/:id/transcript` | Requires the interview's stored **consent** flag (`403` otherwise). Validates the `InterviewTranscript`, stores it **encrypted in S3** via `transcriptStore.put`, sets `transcriptPath` + `transcriptStatus=TRANSCRIBED`. The transcript is **never echoed back**. Audited. |
| `POST /api/v1/interviews/:id/transcribe` | Requires consent (`403` otherwise). Calls `aiClient.transcribeInterview` (self-hosted WhisperX large-v3 + diarisation — **not** a hosted ASR, for data privacy), stores the result encrypted in S3, sets path + `TRANSCRIBED`. The GPU worker auto-scales from zero, so a transient **`503` is expected** and surfaces as a clean **`502`** `AiServiceError`. Audited. |
| `POST /api/v1/interviews/:id/analyze` | Requires a **stored transcript** (`404` if deleted/never stored, `409` if never transcribed). Loads the transcript from S3, builds `AnalyzeInterviewRequest` (`orgContext` from the org, `jobTitle` from the application's job, `scorecardTemplate` from the body or a **built-in standard competency set**), calls `aiClient.analyzeInterview`. **UPSERTs** the AI `Scorecard` row (`reviewerId = null`) writing `ai_summary = draft.summary` and `ai_scorecard_draft = { …draft, competencyEvidence, calibrationFlags }`, sets `transcriptStatus=ANALYZED`. Returns `AnalyzeInterviewResponse`. **The raw transcript is never returned** — only the evidence quotes the AI embedded inside the draft. Audited. |
| `POST /api/v1/scorecards/:id/submit` | The reviewer's **final** (human) scorecard: sets `competency_scores`, `overall`, `reviewerId = the submitting user`, `submittedAt`. Audited. Returns the persisted `InterviewScorecard`. |
| `GET /api/v1/applications/:id/calibration` | Loads **all submitted** scorecards for the application, computes per-competency score **divergence** (flags a spread **> 2 points**), and gathers the stored AI `calibrationFlags` (leading/illegal questions) from the application's interviews' `ai_scorecard_draft`. Returns `PanelCalibration`. **The numeric divergence is computed HERE, not by the AI service** (the AI only supplies the qualitative leading/illegal-question flags). |
| `DELETE /api/v1/interviews/:id/transcript` | **DSAR / right to erasure.** Deletes the S3 object via `transcriptStore.delete`, nulls `transcriptPath`, sets `transcriptStatus=DELETED` + `transcriptDeletedAt`. **Idempotent** (deleting an absent/already-deleted transcript succeeds). Audited. |

### Privacy, consent, retention & DSAR

- **Consent first.** No transcript work happens without candidate consent. Create
  requires `consentObtained === true`; the transcript/transcribe routes re-check the
  *stored* `Interview.consentObtained` flag and refuse with `403` if it is false.
- **Transcripts live only in S3, encrypted at rest, never in a plaintext DB column.**
  `transcriptStore` PUTs with `ServerSideEncryption` — **SSE-KMS in prod** (spec) and
  AES-256 (SSE-S3) in dev/MinIO where a KMS key is typically absent. The DB keeps only
  the object key (`transcriptPath`) + governance metadata. Objects are keyed
  `transcripts/{orgId}/{interviewId}.json` so a DSAR delete targets exactly one object
  and bucket lifecycle rules can be scoped per tenant.
- **Retention.** `transcriptRetentionDeleteAt` is stamped on create (`now + org policy
  days`, default 90) so a retention/cron job can purge expired transcripts; deletion
  reuses the same `transcriptStore.delete` + status-flip path as DSAR.
- **Data minimisation in audit.** Audit payloads record only decision metadata
  (counts, model version, recommendation, bias-indicator count) — never transcript
  text or evidence quotes.
- **Bias check on HR-facing output.** The AI scorecard draft carries a `biasCheck`
  (prompt standard #4); its indicator count is logged on `interview.analyze`.

### S3 transcript store env (validated at boot by `src/env.ts`)

| Var | Purpose |
| --- | ------- |
| `S3_BUCKET` | Bucket holding encrypted transcripts (default `peopleos-dev`). |
| `S3_REGION` | AWS region (default `us-east-1`). |
| `S3_ENDPOINT` | Optional custom endpoint for an S3-compatible store (MinIO in dev). Unset → real AWS S3. Path-style addressing is forced when set. |
| `S3_KMS_KEY_ID` | Optional customer-managed KMS key for SSE-KMS. When unset in prod, the bucket's default KMS key is used (`aws:kms`). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Optional. In dev: explicit creds / MinIO defaults. In prod: omit to use the ambient provider chain (ECS task IAM role). |

## Module 4 — Employee HR Chatbot (RAG over company knowledge)

Standard RAG with conversational memory + escalation. **The chatbot answers ONLY from
retrieved policy chunks.** If the answer is not in the provided context the AI service
SAYS SO and offers escalation — it never invents policy; every claim cites policy name +
section + effective date. The API does **retrieval**; the AI service does the **grounded
generation**, and the API returns its answer verbatim (no post-processing).

### Knowledge base — policy ingestion & versioning (`src/routes/policies.ts`)

| Route | What it does |
| ----- | ------------ |
| `POST /api/v1/policies` | **ADMIN/HRBP only.** Creates a `PolicyDocument` (`ACTIVE`; `version` = prior ACTIVE same-title version + 1), calls `aiClient.ingestPolicy(rawText)` (Layer 2C: semantic chunk + embed `text-embedding-3-large` + SimHash), and stores the returned chunks as `DocumentChunk` rows (`embedding Float[]`, `orgId` set → RLS WITH CHECK, `active=true`). **Supersede (step 5):** a prior ACTIVE doc with the **same title OR an identical SimHash** is marked `SUPERSEDED` and its chunks `active=false`. Stamps `simhash` + `chunksIndexedAt`. Audited. Returns `IngestPolicyResponse`. (`fileUrl` ingestion is not wired in dev — provide `rawText`; prod adds a URL→text fetcher.) |
| `GET /api/v1/policies` | Lists the org's **ACTIVE** documents (newest first). |
| `DELETE /api/v1/policies/:id` | **ADMIN/HRBP only.** Soft-delete: status `ARCHIVED` + chunks `active=false` (no longer retrievable). Row + chunks retained for audit. Audited. |

### Hybrid retrieval (`src/lib/retrieval.ts`)

`retrieveChunks(tx, orgId, queryEmbedding, queryText, k)` loads the org's **ACTIVE**
`DocumentChunk` rows (RLS-scoped via `withTenant`), then scores each two ways — **dense**
cosine over the stored `Float[]` embeddings (brute force in JS) and a **lexical**
keyword-overlap over the chunk text (a cheap BM25 stand-in) — and fuses the two rankings
with **Reciprocal-Rank Fusion** (RRF, k=60). Returns the top-`k` as `RetrievedChunk[]`
with `docTitle` / `sectionPath` / `effectiveDate` joined from the parent `PolicyDocument`
and `score` normalised to `[0,1]`. **Dev is brute-force**; prod swaps `loadActiveChunks`
+ the in-JS scoring for a vector-store ANN query (Pinecone namespace `org:doc_type`,
hybrid dense + BM25) and a cross-encoder re-rank — the fuse/shape layer is unchanged.

### Conversational memory (`src/lib/chatMemory.ts`)

A **dedicated** ioredis client (separate from the BullMQ `queueConnection`) holds a Redis
sliding window keyed `chat:{sessionId}` — the **last 10 turns**, **24h TTL**, refreshed on
every read/append. `getHistory` / `appendTurns` are **best-effort** (a Redis hiccup is
swallowed; the answer is still grounded and the durable `ChatMessage` rows are the source
of truth). The window is the live LLM `history`; the durable record lives in Postgres.

### The ask flow (`src/routes/hrChat.ts`)

`POST /api/v1/hr-chat/ask` (`AskRequest`):

1. **Resolve/create** a `ChatSession` for (org, user, channel). A `sessionId` from another
   org is invisible under RLS → `404` (you cannot resume someone else's conversation).
2. **Load** the Redis memory window for the session.
3. **Embed** the query via `aiClient.embed`, then **hybrid-retrieve** the top-5 ACTIVE
   policy chunks (`retrieveChunks`, inside `withTenant`).
4. **Build `EmployeeChatContext`** from the caller's **own** record — department /
   location / hire date **only**, never anyone else's data. (There is no `Employee`
   table in the frozen schema yet, so these are currently `null`; the contract allows
   null and the AI service falls back to generic framing. Populate when the table lands.)
5. **Call `aiClient.chatAnswer`** — the AI returns a grounded answer + citations + intent
   + an `escalate` flag (sensitive topic / low confidence) + a `topic` label.
6. **Persist** a `user` + an `assistant` `ChatMessage` (citations + topic on the assistant
   turn), append both to Redis, and bump `session.lastActiveAt`.
7. **Escalate:** if `escalate`, open an `HrTicket` (category from `sensitiveTopic`/intent,
   subject from the query, `raisedBy` = caller, status `OPEN`, query pre-populated) and
   audit. Returns `AskResponse` with `ticketId` set.

Other chat routes: `POST /api/v1/hr-chat/messages/:id/feedback` sets `ChatMessage.feedback`
(thumbs up/down for unresolved-query analytics); `GET /api/v1/hr-chat/sessions/:id` returns
the durable `ChatSessionHistory` (Postgres, tenant-scoped). HR tickets:
`GET /api/v1/hr-tickets` (list, optional `?status=`); `PATCH /api/v1/hr-tickets/:id`
(**ADMIN/HRBP** triage — status/assignee; moving to `RESOLVED` stamps `resolvedAt`).

### RAG faithfulness, privacy & escalation

- **Grounded only.** The answer is whatever `chatAnswer` returned. The API does not edit,
  summarise, or supplement it — the no-invention guarantee lives in the AI service prompt.
- **Citations** travel on the assistant `ChatMessage.citations` Json column and in
  `AskResponse.citations`.
- **Sensitive topics force a human.** termination / harassment / salary dispute (and any
  low-confidence answer) set `escalate=true` → an `HrTicket` is opened so a human HRBP
  takes over.
- **Tenant + privacy.** Every query runs through `withTenant`; every create sets `orgId`
  (RLS WITH CHECK); retrieval is **org + active** scoped. Audit payloads record only
  escalation/triage metadata — never the chat content.

## Module 5 — Workforce Analytics Dashboard

Real-time workforce health for HR, People Ops, and leadership. Metrics are **computed in
the API from Postgres** via Prisma (`src/lib/analytics.ts → computeDashboard(tx, orgId)`),
then an LLM narrates / answers questions **grounded only in those metrics**. The wire
contract is the frozen `DashboardMetrics` in `@peopleos/schemas` (analytics.ts); the AI
shapes mirror it as Pydantic in `services/ai/app/schemas.py` (which accepts the metrics as
an opaque dict — the API already validated them against the strict Zod schema).

| Endpoint | Method | Returns | Notes |
|---|---|---|---|
| `/api/v1/analytics/dashboard` | GET | `DashboardMetrics` | 5a–5d, computed from Postgres |
| `/api/v1/analytics/narrative` | POST | `AnalyticsNarrativeResponse` | 5e weekly AI narrative + anomalies |
| `/api/v1/analytics/ask` | POST | `AskDataResponse` | 5e "Ask your data" NL query |

All three are **leadership-only** — restricted to `ADMIN` / `HRBP` / `MANAGER` (a plain
`EMPLOYEE` or a `RECRUITER` gets a 403). Every read is tenant-scoped via `withTenant(orgId)`
so RLS confines the aggregation to the caller's org.

### What `computeDashboard` produces

- **5a Recruiting funnel** (`RecruitingFunnel`) — `byStage` histogram (groupBy
  `Application.stage`); `conversionRates` between consecutive pipeline stages
  (`APPLIED → SCREENING → INTERVIEW → OFFER → HIRED`); `totalApplications`; `openRoles`
  (jobs `status=OPEN`); `timeToFillDays` (avg `createdAt → closedAt` for `CLOSED` jobs);
  `timeToHireDays` (avg `appliedAt → updatedAt` of `HIRED` apps); `offerAcceptanceRate`
  (`SIGNED` / offers that left draft); `sourceOfHire` (`Candidate.source` for `HIRED`
  apps); `slaBreaches` (`OPEN` jobs older than `OPEN_ROLE_SLA_DAYS = 30`).
- **5b Workforce composition** (`WorkforceComposition`, `ACTIVE` employees only) —
  headcount buckets by department / location / level / employment type; `spanOfControl`
  (reports grouped by `managerId`, flagged `WIDE > 8` / `NARROW < 3` / `OK`);
  `promotionRateByLevel` (per level: `lastPromotionDate` within 12 months / total);
  `newHireSuccessRate` (cohort hired between 18 months and 90 days ago with
  `lastReviewRating >= 3`; `null` if the cohort is empty); `internalMobilityRate` —
  **now WIRED to Module 8**: internal `HIRED` moves (`InternalApplication.status = HIRED`,
  dated by `updatedAt`) in the last ~12 months ÷ active headcount; `null` when there is no
  active headcount. The `DashboardMetrics` contract is unchanged — only the previously-null
  field is now populated.
- **5c Engagement & retention** (`EngagementRetention`) — **now WIRED to Module 7**
  (attrition) via `computeEngagement(tx)`, which aggregates the latest `AttritionScore`
  per employee (shared `lib/attritionScores.ts`): `attritionByTier` (per-tier counts,
  zero-filled), `attritionHeatmap` (count per `DEPARTMENT`/`LEVEL` × tier cell), and
  `regrettableCount` (strong performers — perf rating ≥ 4 — at `CRITICAL`/`HIGH` risk).
  `available:true` once the org has any score; it keeps the graceful `available:false`
  empty shape **only** when scoring has never run. `enpsTrend` stays empty (no
  employee-survey integration).
- **5d Skills & talent** (`SkillsTalent`) — **now WIRED to Module 6** via
  `computeSkillsTalent(tx)`, which derives from the org-wide skill inventory
  (`src/lib/skillGraph.ts → skillInventory`): `skillGaps` (skills where open-role demand
  exceeds supply, mapped to `{skill, required, supply, gap}`), `busFactorRisks` (skills
  held by exactly **one** employee org-wide, as `{skill, holders}`), and
  `talentDensityIndex` (share of in-demand skills met internally). `available:true` once
  the graph holds any skill; it keeps the graceful `available:false` empty shape **only**
  when the org has zero skills.

### Approximations & known limits (documented, deliberate)

These are MVP/dev approximations driven by what the **frozen** schema actually carries; the
prod DBT models compute the exact versions from event history:

- **Conversion rates.** Only the *current* `Application.stage` is stored, not the
  transition history, so "reached stage S" is approximated as the count of apps at S or any
  later pipeline stage. The prod DBT model uses the stage-transition events for exactness.
- **`timeToHireDays`** uses the `HIRED` application's `updatedAt` as the hire moment (the
  schema has no explicit "hired at" / "start date" timestamp). Negatives (clock skew /
  backfill) are filtered out.
- **`timeToFillDays`** treats any `CLOSED` job with a `closedAt` as filled.
- **`internalMobilityRate` is `null`.** "% of roles filled internally" needs a link from a
  filled `JobOpening` to whether the hire was an existing `Employee`. The frozen schema has
  no such link (`Application.candidateId → Candidate`, not `Employee`; no internal-apply
  flag), so it is not derivable today — it wires up when Module 8 (internal mobility) lands.

### Production data source (spec 5)

In production these metrics are materialised by **scheduled DBT models in Snowflake**
(near-real-time for recruiting via webhook; daily for HRMS-sourced metrics; weekly for the
AI narrative). `computeDashboard` is the dev/MVP Postgres path **and the shape authority** —
the DBT models must emit the identical camelCase `DashboardMetrics` so the API/AI layers stay
storage-agnostic. We document, not build, the warehouse here.

### 5e — AI narrative & "Ask your data"

The API **always computes the metrics itself** and passes that exact snapshot to the AI
service (`aiClient.narrative` → `/v1/analytics/narrative`, `aiClient.askData` →
`/v1/analytics/ask`, both via the validated `postValidated` helper). The client of
`/analytics/ask` supplies **only a question** — never metrics — so a caller can't smuggle
fabricated numbers in for the AI to "confirm", and the LLM **never generates SQL**. The AI
narrates/answers strictly over the supplied numbers (prompt standard #2 — hallucination
prevention); `AskDataResponse.usedMetrics` reports which metric keys it drew on for
transparency. Responses are Zod-validated against the frozen contracts before they are
trusted (prompt standard #5).

### Export — follow-up (not built here)

PDF report / CSV raw-data export and scheduled **push-to-Slack** (spec 5 technical notes)
are out of scope for this slice. Intended design: a `GET /api/v1/analytics/dashboard.csv`
serialising the same `computeDashboard` snapshot, a PDF renderer over the narrative +
charts, and a BullMQ scheduled job POSTing the narrative to a per-org Slack incoming
webhook.

## Module 6 — Employee Skill Graph

The skill graph (spec Layer 3A "Skill Knowledge Graph") is modelled **relationally in
Postgres** — Neo4j is the documented prod adapter — so RLS tenant isolation applies to
skill data exactly as it does everywhere else. The three node/edge types map to:

- `:Skill` → the `Skill` model (self-relation `parentSkillId ↔ children` = the taxonomy
  hierarchy).
- `:Employee` → the `Employee` model (Module 5; self-relation `managerId ↔ reports` = the
  `REPORTS_TO` edge).
- `(Employee)-[:HAS_SKILL]→(Skill)` → the `SkillRecord` join row, carrying `proficiency`,
  `confidenceScore`, `source`, and the verification fields.

The six spec graph queries are computed **in-API via Prisma joins** in
`src/lib/skillGraph.ts` (every function takes the `withTenant` tx, so RLS scopes all
reads). Routes live in `src/routes/skills.ts`, mounted under `/api/v1`.

| Endpoint | Method | Returns | Roles | Notes |
|---|---|---|---|---|
| `/skills` | GET | `{ items: Skill[] }` | any | the org skill catalog |
| `/skills` | POST | `Skill` | ADMIN/HRBP | create a catalog skill |
| `/employees/:id/skills` | GET | `EmployeeSkillProfile` | any | 6a profile |
| `/employees/:id/skills` | POST | `SkillRecord` | any | self-report (SELF_REPORTED, 0.5) |
| `/skill-records/:id/verify` | PATCH | `SkillRecord` | ADMIN/HRBP/MANAGER | 6d verification |
| `/skills/who-has/:skillId` | GET | `WhoHasSkillResult` | any | query pattern 1 |
| `/employees/:id/skill-gap?targetRoleId=` | GET | `{ gap, growthPath }` | any | 6a, query pattern 3 |
| `/skills/team-map?managerId=` | GET | `TeamSkillMap` | any | 6b |
| `/skills/inventory` | GET | `SkillInventory` | ADMIN/HRBP/MANAGER | 6c |
| `/skills/build-vs-buy?skillId=` | GET | `BuildVsBuyResponse` | ADMIN/HRBP/MANAGER | 6c |

### Skill confidence is ALWAYS derived from the source — never client-supplied

The frozen write contracts (`AddEmployeeSkillRequest`, `VerifySkillRequest`) carry **no**
confidence field. Every `SkillRecord.confidenceScore` is computed **server-side** from the
record's provenance via `confidenceForSource(source)` (spec Layer 3A scoring): self 0.5 /
manager 0.8 / assessment 0.9 / resume 0.6 / project 0.7.

- `POST /employees/:id/skills` always writes `source = SELF_REPORTED`, `confidenceScore =
  0.5`, unverified (`verifiedById`/`verifiedAt` null).
- `PATCH /skill-records/:id/verify` sets `source = MANAGER_VERIFIED`, `confidenceScore =
  0.8`, `verifiedById = caller`, `verifiedAt = now`, and may optionally re-grade
  `proficiency`. A client cannot raise its own confidence.

### Assessment integration (6d) — documented webhook stub

Codility (engineering), Vervoe (ops), and HackerRank (DS/ML) deliver pass/fail results
that should bump a record to `source = ASSESSMENT_VERIFIED` (confidence 0.9). The intended
design is an **inbound webhook** (`POST /api/v1/webhooks/assessments/:provider`,
authenticated by a per-provider HMAC signature, NOT a browser session) that resolves the
employee + skill, then performs the same source-derived confidence write as the verify
route. It is **not built in this slice** — the contract and confidence map already support
it (`confidenceForSource("ASSESSMENT_VERIFIED") = 0.9`).

### Graph query semantics (`src/lib/skillGraph.ts`)

- **`employeeSkillProfile`** — the employee's `HAS_SKILL` edges joined with each skill's
  name + category, best-confidence first; 404 if the employee is not in the tenant.
- **`whoHasSkill`** — all holders of a skill with proficiency + (source-derived)
  confidence, best-first (spec query pattern 1).
- **`skillGap`** — `required` = the target role's `jdStructured.requiredSkills`
  canonicalNames; `matched`/`missing` computed by **case-insensitive** name match against
  the employee's held skills; `gapSize = |missing|`; `coverage = matched / required`
  (`1` when the role lists no required skills — vacuously covered, e.g. an unparsed JD).
- **`teamSkillMap`** — over the manager's direct reports (`Employee.managerId`):
  per-member skills, `busFactor` (skills held by **exactly one** report), and
  `benchStrength` (distinct-holder count per skill). Holders are counted by distinct
  report, so a member can't inflate bench strength.
- **`skillInventory`** / **`computeSupplyDemand`** — per skill: `supply` (# distinct
  employees holding) and `demand` (# **OPEN** `JobOpening`s whose
  `jdStructured.requiredSkills` match by case-insensitive name), `gap = demand - supply`.

### `talentDensityIndex` — best-effort, documented limit

The contract describes the index as "% of employees meeting/exceeding their role's skill
bar", which requires a **per-employee current-role → required-skills** assignment. The
frozen `Employee` model carries no link to a role's required-skill set (only a free-text
`roleTitle`), so that exact figure is **not derivable today**. We compute a best-effort
org-level proxy instead: the share of *in-demand* skills (open-role demand `> 0`) that the
org meets internally (`supply >= demand`); **`null`** when nothing is in demand. It tightens
to the per-employee definition once role assignments exist (Module 8 / a roles model).

### AI features (6a growth path, 6c build-vs-buy)

Both go through `aiClient` (`src/lib/aiClient.ts`) via the validated `postValidated` helper,
so requests and responses are Zod-checked against the frozen contracts in both directions
(prompt standards #2 grounding + #5 validation):

- **`growthPath`** → `POST /v1/skills/growth-path`. `GET /employees/:id/skill-gap` first
  computes the gap from the graph, then hands the AI service the employee's skills, the
  target role + its required skills, **and the org's skill catalog** so the LLM is grounded
  only in skills the org actually defines (it never invents skills). Returns the gap **and**
  the growth path (`{ gap, growthPath }`).
- **`buildVsBuy`** → `POST /v1/skills/build-vs-buy`. `GET /skills/build-vs-buy` computes the
  org signal for one skill — `currentSupply`, open-role `demand`, and `trainableInternally`
  (employees who hold an **adjacent** taxonomy skill — the skill's parent / children /
  siblings — but not the skill itself; the prod `RELATED_TO` graph refines this) — then asks
  the AI for a `BUILD` / `BUY` / `HYBRID` recommendation grounded strictly in those numbers.
  Advisory only.

> The `/v1/skills/*` endpoints are served by `services/ai` (its Module 6 Pydantic models
> already exist in `app/schemas.py`). A 502 surfaces cleanly if the AI service is down.

## Module 7 — Attrition Prediction Engine

A weekly attrition-risk score per employee: an **ML classifier + SHAP** (in `services/ai`;
XGBoost/LightGBM/SHAP/MLflow is the documented prod adapter, a transparent cold-start
scorer in dev) plus an **LLM explanation layer** (`claude-sonnet-4-6`). The API owns the
feature engineering, multi-tenancy, the **governance boundary**, and audit; the scoring +
explanation happen in `services/ai`. Routes live in `src/routes/attrition.ts` under
`/api/v1`, tenant-scoped (`requireTenant` + `withTenant`).

> **The score is ADVISORY ONLY.** No endpoint takes an automated HR action from it.

| Endpoint | Method | Roles | What the API does |
|---|---|---|---|
| `/attrition/score` | POST | ADMIN/HRBP | Loads **ACTIVE, not-opted-out** employees, computes each one's `AttritionFeatures`, calls `aiClient.scoreAttrition` (one batch), **UPSERTs one current `AttritionScore` per employee** (`orgId` set), audits. Returns `RunScoringResponse` `{ scoredCount, skippedOptedOut, byTier, modelVersion, scoredAt }`. |
| `/attrition/summary` | GET | ADMIN/HRBP/MANAGER | Aggregates the latest scores → `AttritionSummary` (tier counts + department/level heatmap + `optedOutCount` + `regrettableCount`). An **aggregate** view; never an individual raw score. |
| `/employees/:id/attrition` | GET | **role-gated** | **ADMIN/HRBP →** full `AttritionEmployeeView` (riskScore + topDrivers + shapValues + AI `narrative` + `recommendedActions`). **MANAGER →** `ManagerAttritionView` (**tier + recommendation ONLY**, no score/SHAP/features) and **only for their own direct reports**. **EMPLOYEE → 403**. |
| `/employees/:id/attrition-opt-out` | PATCH | self or ADMIN/HRBP | Sets `Employee.attritionOptOut`. On opt-out, **deletes** the employee's `AttritionScore` rows. An EMPLOYEE may set only **their own**; ADMIN/HRBP may set anyone's. Audited. |
| `/attrition/bias-audit` | POST | ADMIN/HRBP | Joins the latest scores with a per-request `employeeId → group` mapping (**never stored**) and runs the **Module 1 EEOC 4/5ths disparity engine** over the tier distribution. Returns `{ report, unmatched }`. |

### Governance (spec ethics) — enforced at the route + feature boundary

- **Advisory only.** No automated HR action anywhere; the score drives only the views above.
- **Right to not be profiled.** `attritionOptOut` excludes an employee from **scoring**
  entirely and from every view; setting it **deletes** their stored scores immediately.
- **Managers never see the raw score.** `ManagerAttritionView` is **tier + recommendation
  only** — no `riskScore`, no `shapValues`, no feature values — and is scoped to the
  manager's **own** direct reports (`Employee.managerId` resolved from the acting user's
  Employee record). This is structural (the contract has no score/SHAP field) **and**
  role-gated in the handler.
- **Never shown to the employee.** The `EMPLOYEE` role gets a `403` on the per-employee view.
- **No protected attributes in the model.** `lib/attritionFeatures.ts` reads **only**
  tenure/perf/team/skill columns — name/gender/age/ethnicity are never loaded, by
  construction. The LLM explanation receives a **NON-PII** context (tenure / role title /
  department / level — never name/demographics) and is grounded only in the top drivers.
- **Bias audit never persists demographics.** The mapping arrives per-request, is joined
  in memory, handed to the disparity endpoint, and discarded; the audit log records only
  aggregate counts (number of groups, number of mapped employees), never group assignments.

### Feature engineering (`src/lib/attritionFeatures.ts`) — documented approximations

`computeFeatures(tx, employee, peers, now)` builds the **available subset** of the spec's
feature table. The engagement (1:1 / after-hours / PTO / email-latency), compensation
(salary-vs-band / time-since-raise / equity-cliff), and remaining career signals (internal
applications / training / LinkedIn-update) need integrations PeopleOS does not have, so they
are **omitted** — the scorer treats any feature it is not given as **neutral**. Per field:

- `tenureDays` = `now − hireDate` (`0` if `hireDate` null; never negative).
- `timeInRoleDays` = **best-effort** = `daysSinceLastPromotion` (no "entered role" date or
  role-change history exists; the last promotion is the closest proxy), else `null`.
- `daysSinceLastPromotion` / `daysSinceLastReview` = days since the respective date, `null`
  if never.
- `perfRating` = `lastReviewRating` (1–5), `null` if none.
- `teamAttritionRate90d` = TERMINATED teammates in the last 90d ÷ recent team size. **Team**
  = same `managerId` if present, else same `department`; denominator = current active
  teammates + the employee + the in-window terminations.
- `managerChanged90d` = **`false`** — not derivable (no manager-assignment history in the
  frozen schema; only the current `managerId`). Documented.
- `skillAdditions90d` = the employee's `SkillRecord` rows `createdAt` within 90d (Module 6).

> The frozen `Employee` model has **no termination-date column**, so a TERMINATED teammate
> is counted toward the 90-day window when its (optional) `terminatedAt` is unknown —
> fail-**open** on the risk signal (the conservative choice for a retention feature).

### RiskTier ↔ the reused disparity engine

The Module 1 disparity endpoint is statistics over `RankingTier` (`A`/`B`/`C`/`D`). The bias
audit maps `RiskTier → RankingTier` preserving severity (`CRITICAL→A, HIGH→B, MEDIUM→C,
LOW→D`), so the default flagged outcome **CRITICAL + HIGH** maps to the engine's default
selection tiers **A + B** — no contract change, full reuse of the EEOC 4/5ths machinery.

> The `/v1/attrition/{score,explain}` endpoints are served by `services/ai` (its Module 7
> Pydantic models already exist in `app/schemas.py`). A 502 surfaces cleanly if it is down.

## Module 8 — Internal Talent Marketplace (mobility / succession / gigs)

An internal job board + recommendations: **"recommended roles for you"** (8a),
**"who internally could fill this role?"** (8b), a **gig / stretch marketplace** (8c),
**succession planning** (8d), and **mobility analytics**. The API owns the matching,
multi-tenancy, the **governance boundary**, and audit; the move-recommendation
explanation happens in `services/ai`. Matching primitives live in
`src/lib/mobilityMatch.ts`; routes in `src/routes/mobility.ts` under `/api/v1`,
tenant-scoped (`requireTenant` + `withTenant`).

### Matching is SKILL-GRAPH driven (reuses Module 6)

The single matching primitive is Module 6's `skillGraph.skillGap(employee, role)`, which
returns matched / missing skill names, `gapSize` (= |missing|), and `coverage` (= matched
/ required, vacuously `1` when the role lists no required skills). From that one report
Module 8 derives, for every `(employee, role)` pair:

- **`matchScore` = `coverage`** (a `UnitScore` in `[0,1]`).
- **`readiness`** banded over coverage + gap size (documented thresholds, shared by every
  matcher in `mobilityMatch.ts`):
  - `READY_NOW`  — `coverage ≥ 0.9` **and** `gapSize ≤ 1` (essentially ready).
  - `READY_SOON` — `coverage ≥ 0.6` (a meaningful, closeable gap).
  - `STRETCH`    — below that (a development move).

Reusing `skillGap` means Module 8 never re-implements the JD-parsing / case-insensitive
name-matching logic and stays consistent with the Module 6 growth-path's `stepsAway`.
**Gigs** match the employee's held skills against the free-text `Gig.requiredSkills` array
(not a JD parse), with the same `matched / required` score.

| Endpoint | Method | Roles | What the API does |
|---|---|---|---|
| `/employees/:id/recommended-roles` | GET | own / people-ops | Ranks OPEN `JobOpening`s by coverage; sets `alreadyApplied` from existing internal apps. **EMPLOYEE → own only**; ADMIN/HRBP/RECRUITER → any. |
| `/internal-applications` | POST | **acting employee** | The acting employee applies **for themselves** (resolved from the session principal, never a client id); computes + **stores** `matchScore` at apply time; status `APPLIED`; **409** on duplicate `(employee, role)`. |
| `/internal-applications` | GET | people-ops / own | ADMIN/HRBP/RECRUITER → all; everyone else → **own only**. Returns joined `InternalApplicationView[]`. |
| `/internal-applications/:id` | PATCH | ADMIN/HRBP/RECRUITER | Moves the app along the pipeline. A `HIRED` status feeds 5b `internalMobilityRate`. |
| `/jobs/:id/internal-candidates` | GET | ADMIN/HRBP/RECRUITER/MANAGER | "Who can fill this role?" — ACTIVE employees ranked by coverage. **`flightRisk` = attrition TIER only, for ADMIN/HRBP viewers ONLY** (`null` for RECRUITER/MANAGER). |
| `/jobs/:id/succession` | GET | ADMIN/HRBP | The internal bench ranked by readiness + `readyNow` / `readySoon` / `benchStrength`. Successors carry the attrition tier (leadership-only surface). |
| `/mobility/analytics` | GET | ADMIN/HRBP | `MobilityAnalytics` from `InternalApplication` + `Employee` (fill rate / mobility rate / open roles / counts / by-department), every ratio divide-by-zero-guarded. |
| `/gigs` | GET | any | Lists the org's gigs (OPEN first). |
| `/gigs` | POST | ADMIN/HRBP/MANAGER | Creates a gig (`createdById` = acting user; status `OPEN`). |
| `/gigs/:id/interest` | POST | **acting employee** | The acting employee expresses interest **for themselves** (session-resolved); **409** on duplicate. |
| `/employees/:id/recommended-gigs` | GET | own / people-ops | OPEN gigs ranked by skill coverage. EMPLOYEE → own only. |
| `/employees/:id/mobility-fit?jobOpeningId=` | GET | own / people-ops | Computes the skill match for the `(employee, target role)` pair **then** calls `aiClient.recommendMove` for a grounded fit summary + per-missing-skill development plan. Returns `{ jobOpeningId, match, recommendation }`. 502 if the AI service is down. |

### Governance (spec ethics) — enforced at the route boundary

- **Flight risk is the Module 7 attrition TIER only — never the raw score** — and is
  attached to internal candidates **only for ADMIN/HRBP viewers** (`null` for everyone
  else). This is gated in the `mobility.ts` handler (`includeFlightRisk` passed to
  `internalCandidates`); `mobilityMatch.ts` only ever reads the `riskTier` off the latest
  `AttritionScore` (via `lib/attritionScores.ts`), never the `riskScore`. Succession is an
  ADMIN/HRBP-only surface, so the tier is always surfaced to that leadership view.
- **Employees act on their OWN behalf.** Applying / expressing interest resolves the
  **acting** employee from the session principal (Clerk id → internal `User.id` →
  `Employee.userId`, exactly like the manager resolution in `routes/attrition.ts`) — the
  request body carries **no** `employeeId`, so a caller can never apply as someone else.
  An `EMPLOYEE` may read only their **own** recommendations / applications; people-ops
  roles (ADMIN/HRBP/RECRUITER) may read anyone's.
- **The AI move recommendation receives a NON-PII context** (role title / level /
  department — never name/demographics), mirroring the attrition explanation's privacy
  guard, and is grounded only in the supplied matched/missing skills + readiness.
- **Multi-tenancy + audit.** Every query goes through `withTenant`; every create stamps
  `orgId`; creates / status changes are written to the audit log (governance metadata only).

### Documented approximations & limits

- **Matching is per-employee sequential** (`recommendedRoles` / `internalCandidates` /
  `successionPlan` call `skillGap` once per `(employee, role)` inside one tenant tx). This
  is the MVP path (mirrors the per-employee attrition feature computation); a prod adapter
  would push the coverage join into SQL or the Neo4j skill graph for large orgs.
- **`internalFillRate`** = internal hires ÷ **total internal applications** (the share of
  internal applications that resulted in a hire), `null` when there are none — the analytics
  contract defines it as "internal hires / all hires in the window", and the internal
  application is the only internal-hire signal the schema carries (an `Application` →
  `Candidate`, not `Employee`).
- A gig's `requiredSkills` is free text, so gig matching is a **name** match against held
  skills (no taxonomy adjacency / JD parse) — deliberately simple for the stretch surface.

> The `/v1/mobility/recommend` endpoint is served by `services/ai` (its Module 8 Pydantic
> models already exist in `app/schemas.py`). A 502 surfaces cleanly if it is down.

## Module 9 — Workflow Automation Engine

HR processes are modelled as a **durable, DB-persisted state machine over Postgres** —
the **dev engine**. The `WorkflowDefinition` / `WorkflowInstance` / `WorkflowTask` rows
**are** the durable state: every transition commits inside the caller's tenant
transaction, so a crash/restart resumes exactly where it left off. **Temporal.io** is the
documented **prod** execution substrate (spec Module 9) — we do **not** add it; the adapter
seam is documented in `src/lib/workflowEngine.ts` and `src/jobs/workflowTick.ts`.

The engine (**`src/lib/workflowEngine.ts`**) — every mutator takes the `withTenant` tx:

| Function | What it does |
| -------- | ------------ |
| `startInstance(tx, def, …)` | create a RUNNING instance → `advance()` (never observed RUNNING at rest) |
| `advance(tx, inst, def)` | walk steps from `currentStepId`: AUTO steps (NOTIFICATION / AI_TASK / BRANCH) run inline + record a COMPLETED task; HUMAN steps (TASK / APPROVAL / TIMER) create a PENDING task, set WAITING, and STOP; no next → COMPLETED |
| `completeTask(tx, task, …)` | mark COMPLETED (outcome stored) → advance from the step's `next`; a **REJECTED** APPROVAL ends the instance (CANCELLED) unless the step carries a branch that handles it |
| `processTimersAndSla(tx)` | TIMER tasks past `dueAt` → fire + advance; PENDING human tasks past `dueAt` → OVERDUE (or ESCALATED when `config.escalateToRole` applies) |
| `emitEvent(tx, …)` | start an instance for every ACTIVE EVENT definition whose `eventType` matches |
| `evaluateCondition(ctx, cond)` | the **SAFE** declarative branch comparator (EQ / NE / EXISTS / GT / LT over a context field; dot-paths; own-properties only) |

**Correctness properties (the load-bearing ones):**

- **Resumable** — each non-terminal transition persists `currentStepId` *before* continuing.
- **Loop-safe** — `advance` caps iterations (`MAX_STEPS_PER_ADVANCE`) **and** tracks visited
  step ids within one pass: a cyclic BRANCH (a backward edge) **FAILs** the instance, it
  never hangs. An unknown `next`/branch target also FAILs (malformed definition).
- **Safe branches** — `evaluateCondition` is a pure field/op/value comparison. **No `eval`,
  no `new Function`, no string interpolation into code, no prototype-chain traversal.** An
  unknown op or a type-mismatched compare returns `false` (fails closed). A REJECTED outcome
  is written into `instance.context` so a downstream BRANCH can route on it via the comparator.
- **Authorised** — task completion is gated at the route: **only** the task's direct
  assignee (`assigneeId`), a holder of its `assigneeRole`, or an **ADMIN/HRBP** may complete
  it (else 403). The engine records `completedById`.
- **AI-resilient** — an `AI_TASK` calls `aiClient.draftWorkflow` but **never blocks the
  engine**: any AI failure records a "pending manual follow-up" note (the task is flagged
  SKIPPED so the gap is visible in the inbox) and the walk continues.
- **Idempotent under the tick** — completed tasks are no-ops on re-run; a SCHEDULED
  definition only re-fires once its `everyHours` window has elapsed since its last instance.

**Worker tick** (**`src/jobs/workflowTick.ts`**, registered in `worker.ts` on a 1-minute
interval, mirroring the retention sweep): a cross-org sweep. **Discovery** is cross-org so it
uses the **owner** client (BYPASSES RLS, READ-ONLY — like `retentionPurge`); **processing**
runs **per-org inside `withTenant`** on the RLS-subject app client, so the engine code is
identical to the request path and the audit-log GUC is always set. No-ops without the owner
`DATABASE_URL`. In prod, Temporal's durable timers replace this sweep entirely.

> AI authoring (`POST /workflow-definitions/draft`) is a passthrough to `services/ai`
> (`/v1/workflows/draft`). The draft is **advisory** and is **never persisted** — a human
> reviews it and submits it through `POST /workflow-definitions` (which validates the step
> DAG: unique ids + resolvable `next`/branch targets). The `orgId` ALWAYS comes from the
> authenticated session, never the client body. A 502 surfaces cleanly if the AI is down.

## Module 10 — Agentic HR Assistant (the capstone)

The **org-wide, role-aware agent** that orchestrates **every prior module's capability as a
tool**. A ReAct loop in `services/ai` plans tool use; the API is the **trusted execution +
governance plane**. The defining property: **the agent can never become a confused deputy.**

**Public chat surface (`src/routes/assistant.ts`, under `/api/v1`, `requireTenant`):**

| Endpoint | What it does |
| -------- | ------------ |
| `POST /assistant/chat` | load-or-create the caller's **own** session → replay recent history → persist the user turn → run the agent with the **trusted** `context` → persist the assistant turn + a **summarised** tool trace → return `{ sessionId, reply, toolCalls, suggestedActions }`. Audited. |
| `GET /assistant/sessions` | the caller's **own** `AssistantSessionSummary[]` (newest first) |
| `GET /assistant/sessions/:id` | the caller's **own** `AssistantSessionDetail` (messages + per-turn trace); a foreign / not-owned session is a **404** (existence is never revealed) |

Sessions are **USER-SCOPED**: a user only ever touches their own sessions (ownership gated on
top of RLS). The reply is **CoT-free** and the persisted `toolCalls` is a **summary only**
(`{ tool, ok, summary }`) — never raw, possibly-sensitive tool output.

### The security model — the whole point of the module

```
 user ── authed session ──▶ POST /api/v1/assistant/chat
                              │  builds the TRUSTED AssistantContext { orgId, userId, role }
                              │  from the session (NEVER the body); maps Clerk id → User.id
                              ▼
 services/ai  ReAct agent ── attaches context to EVERY tool dispatch PROGRAMMATICALLY ──┐
   (LLM never sees the context; agent-side role filter + identity-key strip on args)    │
                                                                                        ▼
 POST /internal/assistant/tool  (secret-authed, x-internal-secret, fail-closed)  { tool, args, context }
   1. tool ∈ canonical vocabulary?                       else ok:false / "unknown_tool"
   2. TOOL_ROLES[tool] permits context.role?             else ok:false / "forbidden"  ← THE GATE
   3. run inside withTenant(context.orgId) + re-run THAT module's own governance from context.role
   4. WRITE tools (raise_hr_ticket / start_workflow / generate_outreach) are AUDITED here
```

- **Identity comes ONLY from `body.context`** — the dispatcher **ignores** any
  `orgId`/`userId`/`role` a (prompt-injected) agent smuggles into `body.args`. Tool args
  carry only tool-specific params (`jobId`, `targetRoleId`, …).
- **`TOOL_ROLES` (`src/lib/assistantTools.ts`) is the authoritative allowlist** — re-derived
  from `context.role` on **every** call. The agent's tool choice is **advisory, not
  authoritative**: a disallowed tool runs **nothing** and returns `ok:false`/`forbidden`.
  This is independent of the agent-side role filter in `services/ai` — a bug there can only
  *surface* a tool, never *grant* it.
- **Each module's own governance is re-run from the trusted role**, reusing the exact
  route-level logic: `get_employee_attrition` gives a **MANAGER** the **TIER + recommendation
  for an own report only** (never the raw score / SHAP — reusing the `routes/attrition.ts`
  rule); `find_internal_candidates` surfaces the attrition **flight-risk tier to ADMIN/HRBP
  only**; the self-service tools (`get_my_skill_profile` / `get_skill_gap` /
  `recommended_roles`) resolve **the caller's own employee** from `context.userId` (people-ops
  may pass an explicit `employeeId`); the org-wide analytics / succession / inventory tools
  are **ADMIN/HRBP only**.
- The internal dispatcher (`src/routes/internalAssistant.ts`) shares the **same constant-time
  `x-internal-secret` guard** as `/internal/copilot/*` (factored into `src/lib/internalSecret.ts`;
  **fail-closed** when `AI_SERVICE_SECRET` is unset). Both `/internal/*` routers are mounted at
  the **root**, outside `/api/v1`, with **no Clerk/tenancy preHandler** — bind them on the
  internal network only.

### Tool registry → module lib (all reuse — nothing re-implemented)

| Tool | Roles | Backs onto |
| ---- | ----- | ---------- |
| `answer_policy_question` | all | Module 4 RAG (`retrieval.ts` + `aiClient.chatAnswer`) |
| `raise_hr_ticket` **(WRITE)** | all | Module 4 `HrTicket` create + audit |
| `get_my_skill_profile` / `get_skill_gap` / `recommended_roles` | all | Modules 6/8 for the caller's **own** employee |
| `list_my_tasks` | all | Module 9 inbox (own `assigneeId` / `assigneeRole`, OPEN only) |
| `rank_candidates` / `draft_jd` / `generate_outreach` **(WRITE)** / `find_internal_candidates` | recruiter+people | Modules 1/2/8 |
| `get_employee_attrition` (governed) / `get_team_skill_map` | manager+people | Modules 7/6 |
| `get_analytics_dashboard` / `ask_workforce_data` / `get_attrition_summary` / `get_succession` / `get_skill_inventory` / `draft_workflow` / `start_workflow` **(WRITE)** | HRBP/ADMIN | Modules 5/7/8/6/9 |

Every dispatch returns a `ToolInvokeResponse { ok, data, summary, error }`: a **short,
non-sensitive `summary`** for the trace plus the structured `data` the agent reasons over.
Errors are **caught** and returned as `ok:false` so the ReAct loop never crashes. Each chat
turn and **every WRITE tool** is written to the audit log (governance metadata only — which
tools ran + their `ok` flags — never message text or tool output).

> The agent itself lives in `services/ai` (`/v1/assistant/chat`, mirrored by
> `aiClient.assistantChat`). It **confirms intent before any WRITE tool**; the dispatcher is
> the last line that records what actually ran. The tool-arg names here mirror the AI-side
> tool schemas (`services/ai/app/assistant/tools.py`): e.g. `find_internal_candidates`/
> `get_succession` take `roleId`, `generate_outreach` takes `candidateId`+`jobId`,
> `ask_workforce_data` takes `query`, `start_workflow` takes `workflowName`.

## Multi-tenancy (read this before touching a query)

The API connects to Postgres as the **`peopleos_app`** role (`DATABASE_URL_APP`),
which is **subject to RLS** — the owner role (`DATABASE_URL`) bypasses RLS and must
never serve traffic. Every tenant query MUST go through `withTenant(orgId, fn)`,
which opens a `$transaction` and first runs a parameterised, transaction-local
`set_config('app.current_org_id', $orgId, true)`. RLS policies read that GUC; if it
is unset, every predicate is false and **zero rows** are visible (fail-closed).

The org id comes from the verified Clerk session in production. In dev/test only, an
`X-Org-Id` header is trusted as a convenience for driving the seed (see below).

## Run locally

From the **repo root** (this app is a pnpm workspace member):

```bash
# 0. Install deps (workspace) and generate the Prisma client
pnpm install
pnpm db:generate

# 1. Start local infra (Postgres+pgvector, Redis, Neo4j, MinIO)
pnpm infra:up

# 2. Create the schema, apply RLS policies, and seed a demo org
pnpm db:migrate        # prisma migrate dev
pnpm db:rls            # psql "$DATABASE_URL" -f prisma/rls.sql  (run as the OWNER role)
pnpm db:seed           # one org + users + a job + candidates + applications
#   (pnpm db:setup runs migrate + rls + seed in one shot)

# 3. Copy env and start the API in watch mode
cp .env.example .env   # then fill in any required values
pnpm --filter @peopleos/api dev    # tsx watch src/server.ts
```

The API listens on `http://localhost:3001` by default (`API_PORT`). The OpenAPI UI
is at `http://localhost:3001/docs`.

> The `rank` route calls the Python AI service. Start it alongside with
> `pnpm ai:dev` (FastAPI on `http://localhost:8000`, matching `AI_SERVICE_URL`).
> `GET /health` reports `aiService: degraded` when it is not running, but the rest
> of the CRUD API works without it.

### Required env (validated at boot by `src/env.ts`)

| Var                | Purpose                                                        |
| ------------------ | ------------------------------------------------------------- |
| `DATABASE_URL_APP` | Postgres URL for the **RLS-subject** `peopleos_app` role      |
| `REDIS_URL`        | Redis URL for the BullMQ `ranking` queue (auto-trigger)       |
| `AI_SERVICE_URL`   | Base URL of `services/ai` (default `http://localhost:8000`)   |
| `AI_SERVICE_SECRET`| Shared secret for the internal tool routers — Module 2c `/internal/copilot/*` **and** Module 10 `/internal/assistant/tool`. **Required in production**; if unset both routers refuse all calls (fail-closed). |
| `API_HOST`/`API_PORT` | Listener address (defaults `0.0.0.0` / `3001`)             |
| `CLERK_SECRET_KEY` | Required in production; optional in dev (enables real auth)   |
| `S3_BUCKET`/`S3_REGION` | Module 3 — encrypted transcript store (defaults `peopleos-dev` / `us-east-1`) |
| `S3_ENDPOINT` | Optional — custom S3 endpoint (MinIO in dev); unset → real AWS S3 |
| `S3_KMS_KEY_ID` | Optional — customer-managed KMS key for SSE-KMS transcript encryption |
| `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` | Optional — S3 creds (dev) or omit for the IAM role chain (prod) |
| `NODE_ENV`, `LOG_LEVEL` | Runtime + log level                                      |

## Example requests (dev, using the seeded org)

The seed creates org `00000000-0000-0000-0000-000000000001` with a job
(`…0000000000b1`) and two candidates with applications. In dev, pass the tenant via
the `X-Org-Id` header (no Clerk session needed):

```bash
ORG=00000000-0000-0000-0000-000000000001

# List jobs for the tenant
curl -s -H "X-Org-Id: $ORG" http://localhost:3001/api/v1/jobs | jq

# List candidates
curl -s -H "X-Org-Id: $ORG" http://localhost:3001/api/v1/candidates | jq

# Create a job (starts in DRAFT)
curl -s -X POST http://localhost:3001/api/v1/jobs \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"title":"Senior ML Engineer","type":"FULL_TIME","department":"Eng"}' | jq

# List a job's pipeline (applications)
curl -s -H "X-Org-Id: $ORG" \
  "http://localhost:3001/api/v1/applications?jobId=00000000-0000-0000-0000-0000000000b1" | jq

# Run the AI ranking for an application (Module 1). Requires the AI service running
# and the candidate to have a parsed profile. Returns a CandidateRanking WITHOUT the
# chain-of-thought reasoning (CoT is persisted server-side for audit only).
curl -s -X POST \
  -H "X-Org-Id: $ORG" \
  "http://localhost:3001/api/v1/applications/<APPLICATION_ID>/rank" | jq

# Batch-screen a whole job pipeline (default stage SCREENING; override with ?stages=).
# Returns rankings sorted best-first (CoT-free) plus any skipped candidates.
curl -s -X POST \
  -H "X-Org-Id: $ORG" \
  "http://localhost:3001/api/v1/jobs/<JOB_ID>/rank?stages=SCREENING,APPLIED" | jq

# Bias audit (ADMIN/HRBP only). Demographics are supplied per-request and NEVER stored.
curl -s -X POST \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" -H "content-type: application/json" \
  -d '{"demographics":[{"candidateId":"…","group":"A"},{"candidateId":"…","group":"B"}]}' \
  "http://localhost:3001/api/v1/jobs/<JOB_ID>/bias-audit" | jq

# ── Module 2 — Recruiter Copilot ───────────────────────────────────────────────

# 2a JD writer (server supplies orgContext + the org's recent JDs as few-shot)
curl -s -X POST http://localhost:3001/api/v1/copilot/jd \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"roleTitle":"Senior ML Engineer","seniority":"SENIOR","department":"Eng","teamContext":"Applied ML platform team","hiringManagerNotes":"Must ship LLM features"}' | jq

# 2b outreach for an application (requires the candidate to have a parsed profile)
curl -s -X POST \
  -H "X-Org-Id: $ORG" \
  "http://localhost:3001/api/v1/applications/<APPLICATION_ID>/outreach" | jq

# 2c recruiter chat (orgId comes from the session, NOT the body)
curl -s -X POST http://localhost:3001/api/v1/copilot/chat \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Find 5 candidates in our pool for the ML role"}]}' | jq

# 2d analyse a scraped LinkedIn profile vs the org's OPEN roles (consent required)
curl -s -X POST http://localhost:3001/api/v1/copilot/linkedin/analyze \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"consent":true,"profile":{"url":"https://www.linkedin.com/in/jane","name":"Jane Doe","headline":"ML Engineer","location":"Berlin","about":null,"experience":[],"education":[],"skills":["Python","PyTorch"]}}' | jq

# 2d add a scraped profile to the candidate pool (consent required)
curl -s -X POST http://localhost:3001/api/v1/copilot/linkedin/add-to-pool \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"consent":true,"source":"LINKEDIN","profile":{"url":"https://www.linkedin.com/in/jane","name":"Jane Doe","headline":"ML Engineer","location":"Berlin","about":null,"experience":[],"education":[],"skills":["Python","PyTorch"]}}' | jq

# ── Module 2c internal tool router (called by the AI service, NOT browsers) ─────
# Root-mounted, OUTSIDE /api/v1, NO Clerk/tenancy. Auth = x-internal-secret shared
# secret; tenant = the orgId IN THE BODY (set by the API from the authed chat request).
curl -s -X POST http://localhost:3001/internal/copilot/search-candidates \
  -H "x-internal-secret: $AI_SERVICE_SECRET" -H "content-type: application/json" \
  -d "{\"orgId\":\"$ORG\",\"query\":\"python\",\"limit\":5}" | jq

# ── Module 3 — Interview Intelligence (consent + encrypted S3 + DSAR) ───────────

# Create an interview — consentObtained MUST be literal true (else 400). Sets
# transcriptStatus=PENDING and transcriptRetentionDeleteAt = now + org policy (90d).
curl -s -X POST http://localhost:3001/api/v1/interviews \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"applicationId":"<APPLICATION_ID>","type":"VIDEO","consentObtained":true}' | jq

# Submit an already-diarised transcript → stored ENCRYPTED in S3 (never echoed back).
# Requires the interview's stored consent flag (403 otherwise).
curl -s -X POST http://localhost:3001/api/v1/interviews/<INTERVIEW_ID>/transcript \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"transcript":{"source":"UPLOAD","diarised":true,"durationSec":1800,"language":"en","segments":[{"speakerLabel":"Interviewer A","speakerRole":"INTERVIEWER","startSec":0,"endSec":5,"text":"Tell me about a hard project."},{"speakerLabel":"Candidate","speakerRole":"CANDIDATE","startSec":5,"endSec":40,"text":"At my last role I led ..."}]}}' | jq

# Transcribe from audio via self-hosted WhisperX (AI service). A 503 while the GPU
# worker is cold surfaces as a clean 502. Requires consent.
curl -s -X POST http://localhost:3001/api/v1/interviews/<INTERVIEW_ID>/transcribe \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"audioUrl":"https://internal.example.com/recordings/abc.mp4","source":"ZOOM"}' | jq

# Analyse the stored transcript (4 AI steps). Omit the body to use the built-in
# standard competency set, or pass a role-specific scorecardTemplate. Returns the
# scorecard draft + competency evidence + per-transcript calibration flags. The raw
# transcript is NEVER returned (only evidence quotes inside the draft).
curl -s -X POST http://localhost:3001/api/v1/interviews/<INTERVIEW_ID>/analyze \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" -d '{}' | jq

# Submit a reviewer's final (human) scorecard.
curl -s -X POST http://localhost:3001/api/v1/scorecards/<SCORECARD_ID>/submit \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"competencyScores":[{"competencyId":"communication","score":4,"evidence":"Clear STAR answer"}],"overallRecommendation":"YES"}' | jq

# Panel calibration: per-competency divergence (>2 spread) + gathered AI flags.
curl -s -H "X-Org-Id: $ORG" \
  http://localhost:3001/api/v1/applications/<APPLICATION_ID>/calibration | jq

# DSAR: delete the transcript (idempotent). Removes the S3 object + marks DELETED.
curl -s -X DELETE http://localhost:3001/api/v1/interviews/<INTERVIEW_ID>/transcript \
  -H "X-Org-Id: $ORG" | jq

# ── Module 4 — Knowledge base + Employee HR Chatbot (RAG) ───────────────────────

# Ingest a policy (ADMIN/HRBP). Chunks + embeds + SimHash; supersedes a prior same-title
# (or identical-SimHash) ACTIVE version. Returns the document + chunkCount.
curl -s -X POST http://localhost:3001/api/v1/policies \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" -H "content-type: application/json" \
  -d '{"title":"PTO Policy","docType":"PTO","effectiveDate":"2026-01-01","rawText":"Section 1. Full-time employees accrue 20 days of paid time off per year ..."}' | jq

# List ACTIVE policy documents.
curl -s -H "X-Org-Id: $ORG" http://localhost:3001/api/v1/policies | jq

# Ask the chatbot. Embeds + hybrid-retrieves + grounded answer; opens an HR ticket if it
# escalates (sensitive topic / low confidence). Omit sessionId to start a new session.
curl -s -X POST http://localhost:3001/api/v1/hr-chat/ask \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"message":"How many PTO days do I get?","channel":"WEB"}' | jq

# Continue the same session (resume-from-any-channel). Pass the sessionId from above.
curl -s -X POST http://localhost:3001/api/v1/hr-chat/ask \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d '{"message":"And does that carry over?","sessionId":"<SESSION_ID>","channel":"WEB"}' | jq

# Thumbs up/down on an assistant answer (analytics on unresolved queries).
curl -s -X POST http://localhost:3001/api/v1/hr-chat/messages/<MESSAGE_ID>/feedback \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" -d '{"feedback":"positive"}' | jq

# Durable session transcript (Postgres record; the Redis window is only live LLM context).
curl -s -H "X-Org-Id: $ORG" http://localhost:3001/api/v1/hr-chat/sessions/<SESSION_ID> | jq

# List escalation tickets (optionally filter by status).
curl -s -H "X-Org-Id: $ORG" "http://localhost:3001/api/v1/hr-tickets?status=OPEN" | jq

# Triage a ticket (ADMIN/HRBP) — assign + move to IN_PROGRESS.
curl -s -X PATCH http://localhost:3001/api/v1/hr-tickets/<TICKET_ID> \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" -H "content-type: application/json" \
  -d '{"status":"IN_PROGRESS","assigneeId":"<HRBP_USER_ID>"}' | jq

# ── Module 5 — Workforce Analytics Dashboard (ADMIN/HRBP/MANAGER) ───────────────

# Dashboard metrics (5a-5d), computed from Postgres. A RECRUITER/EMPLOYEE gets a 403.
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  http://localhost:3001/api/v1/analytics/dashboard | jq

# 5e AI narrative — the API computes the metrics, the AI service narrates them.
# Requires the AI service running. No request body (metrics are never client-supplied).
curl -s -X POST http://localhost:3001/api/v1/analytics/narrative \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" | jq

# 5e "Ask your data" — supply ONLY a question; the API supplies the metrics snapshot
# and the AI answers grounded strictly in them (no SQL is ever generated).
curl -s -X POST http://localhost:3001/api/v1/analytics/ask \
  -H "X-Org-Id: $ORG" -H "X-User-Role: MANAGER" -H "content-type: application/json" \
  -d '{"question":"How many engineers do we have, and what is our offer acceptance rate?"}' | jq

# ── Module 6 — Employee Skill Graph ─────────────────────────────────────────────

# Create a catalog skill (ADMIN/HRBP). Confidence is never part of any skill write.
SKILL=$(curl -s -X POST http://localhost:3001/api/v1/skills \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" -H "content-type: application/json" \
  -d '{"canonicalName":"Kubernetes","category":"TECHNICAL"}' | jq -r .id)

# Employee self-reports the skill → SELF_REPORTED, confidenceScore 0.5 (server-derived).
curl -s -X POST "http://localhost:3001/api/v1/employees/$EMP/skills" \
  -H "X-Org-Id: $ORG" -H "content-type: application/json" \
  -d "{\"skillId\":\"$SKILL\",\"proficiency\":\"PRACTITIONER\"}" | jq

# Manager verifies a claimed skill → MANAGER_VERIFIED, confidenceScore 0.8.
curl -s -X PATCH "http://localhost:3001/api/v1/skill-records/$REC/verify" \
  -H "X-Org-Id: $ORG" -H "X-User-Role: MANAGER" -H "content-type: application/json" \
  -d '{"proficiency":"ADVANCED"}' | jq

# Who has a skill? Employee profile (6a). Team skill map (6b). Org inventory (6c).
curl -s -H "X-Org-Id: $ORG" "http://localhost:3001/api/v1/skills/who-has/$SKILL" | jq
curl -s -H "X-Org-Id: $ORG" "http://localhost:3001/api/v1/employees/$EMP/skills" | jq
curl -s -H "X-Org-Id: $ORG" "http://localhost:3001/api/v1/skills/team-map?managerId=$MGR" | jq
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  http://localhost:3001/api/v1/skills/inventory | jq

# Gap to a target role + AI growth path (requires the AI service). Build-vs-buy (6c).
curl -s -H "X-Org-Id: $ORG" \
  "http://localhost:3001/api/v1/employees/$EMP/skill-gap?targetRoleId=$JOB" | jq
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  "http://localhost:3001/api/v1/skills/build-vs-buy?skillId=$SKILL" | jq

# ── Module 7 — Attrition Prediction Engine (ADVISORY ONLY; strict governance) ────

# Run scoring over the org (ADMIN/HRBP). Skips opted-out employees; UPSERTs one current
# score each. Requires the AI service. Returns scoredCount / skippedOptedOut / byTier.
curl -s -X POST http://localhost:3001/api/v1/attrition/score \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" | jq

# Aggregate summary (ADMIN/HRBP/MANAGER): tier counts + department/level heatmap +
# optedOutCount + regrettableCount. A RECRUITER/EMPLOYEE gets a 403.
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: MANAGER" \
  http://localhost:3001/api/v1/attrition/summary | jq

# Full per-employee view (ADMIN/HRBP): riskScore + topDrivers + shapValues + AI narrative.
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  "http://localhost:3001/api/v1/employees/$EMP/attrition" | jq

# Manager view of THEIR OWN report: tier + recommendedActions ONLY (no score/SHAP).
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: MANAGER" -H "X-User-Id: $MGR_USER" \
  "http://localhost:3001/api/v1/employees/$EMP/attrition" | jq

# Employee viewing any attrition score → 403 (never shown to the employee).
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: EMPLOYEE" \
  "http://localhost:3001/api/v1/employees/$EMP/attrition" | jq

# Opt out of profiling (self, or ADMIN/HRBP for anyone) — deletes the employee's scores.
curl -s -X PATCH "http://localhost:3001/api/v1/employees/$EMP/attrition-opt-out" \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" -H "content-type: application/json" \
  -d '{"optOut":true}' | jq

# Monthly bias audit (ADMIN/HRBP). Demographics supplied per-request and NEVER stored;
# CRITICAL+HIGH count as the flagged outcome by default.
curl -s -X POST http://localhost:3001/api/v1/attrition/bias-audit \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" -H "content-type: application/json" \
  -d '{"demographics":[{"employeeId":"…","group":"A"},{"employeeId":"…","group":"B"}]}' | jq

# ── Module 8 — Internal Talent Marketplace (mobility / succession / gigs) ─────────

# Recommended OPEN roles for an employee (skill-graph coverage + readiness + alreadyApplied).
# EMPLOYEE may view only their OWN; people-ops may view any employee's.
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  "http://localhost:3001/api/v1/employees/$EMP/recommended-roles" | jq

# Apply for an internal role — the ACTING employee applies for THEMSELVES (resolved from
# the session principal via X-User-Id; no employeeId in the body). 409 on a duplicate.
curl -s -X POST http://localhost:3001/api/v1/internal-applications \
  -H "X-Org-Id: $ORG" -H "X-User-Role: EMPLOYEE" -H "X-User-Id: $EMP_USER" \
  -H "content-type: application/json" -d '{"jobOpeningId":"'"$JOB"'","note":"keen on this"}' | jq

# List internal applications (people-ops → all; everyone else → own only).
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: RECRUITER" \
  http://localhost:3001/api/v1/internal-applications | jq

# Move an internal application along the pipeline (ADMIN/HRBP/RECRUITER). HIRED feeds 5b.
curl -s -X PATCH "http://localhost:3001/api/v1/internal-applications/$APP" \
  -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" -H "content-type: application/json" \
  -d '{"status":"SHORTLISTED"}' | jq

# Who internally could fill this role? flightRisk TIER is non-null ONLY for ADMIN/HRBP.
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  "http://localhost:3001/api/v1/jobs/$JOB/internal-candidates" | jq

# Succession plan for a role (ADMIN/HRBP): bench ranked by readiness + readyNow/readySoon.
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  "http://localhost:3001/api/v1/jobs/$JOB/succession" | jq

# Org-wide mobility analytics (ADMIN/HRBP).
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  http://localhost:3001/api/v1/mobility/analytics | jq

# Gigs: list, create (ADMIN/HRBP/MANAGER), express interest for SELF, recommended gigs.
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: EMPLOYEE" http://localhost:3001/api/v1/gigs | jq
curl -s -X POST http://localhost:3001/api/v1/gigs \
  -H "X-Org-Id: $ORG" -H "X-User-Role: MANAGER" -H "content-type: application/json" \
  -d '{"title":"Migrate billing to Stripe","description":"6-week stretch","requiredSkills":["TypeScript","Stripe"],"durationWeeks":6}' | jq
curl -s -X POST "http://localhost:3001/api/v1/gigs/$GIG/interest" \
  -H "X-Org-Id: $ORG" -H "X-User-Role: EMPLOYEE" -H "X-User-Id: $EMP_USER" | jq
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: EMPLOYEE" -H "X-User-Id: $EMP_USER" \
  "http://localhost:3001/api/v1/employees/$EMP/recommended-gigs" | jq

# Mobility fit: skill match for (employee, target role) + AI move recommendation (needs AI).
curl -s -H "X-Org-Id: $ORG" -H "X-User-Role: HRBP" \
  "http://localhost:3001/api/v1/employees/$EMP/mobility-fit?jobOpeningId=$JOB" | jq
```

Omitting `X-Org-Id` (or sending a non-uuid) yields a `401`/`400` `ApiError`:

```json
{ "error": { "code": "ORG_CONTEXT_MISSING", "message": "A valid organisation context (orgId) is required for this request." } }
```

> In production the `X-Org-Id` fallback is disabled — the org id is taken only from
> the verified Clerk session. Never trust a client-supplied tenant id in prod.

## Scripts

| Script         | Action                                  |
| -------------- | --------------------------------------- |
| `dev`          | `tsx watch src/server.ts`               |
| `worker`       | `tsx watch src/worker.ts` (dev worker)  |
| `worker:start` | `node dist/worker.js` (prod worker)     |
| `build`        | `tsc -p tsconfig.json`                  |
| `start`        | `node dist/server.js`                   |
| `typecheck`    | `tsc -p tsconfig.json --noEmit`         |
| `lint`         | `eslint src`                            |
| `test`         | `vitest run`                            |

## Conventions

- The wire contract is **camelCase end-to-end**; all shapes come from
  `@peopleos/schemas` (`workspace:*`). Routes never redefine those shapes.
- Every response is serialized through its Zod contract, so DB-only columns (e.g.
  `CandidateRanking.reasoning`) cannot leak — chain-of-thought is never returned to
  clients (prompt standard #3).
- Errors always return the uniform `ApiError` envelope `{ error: { code, message, details? } }`.
