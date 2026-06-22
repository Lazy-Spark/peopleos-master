# PeopleOS AI Engine (`services/ai`)

Python FastAPI + LangGraph service implementing the resume-parse pipeline (spec
Layer 2A), **Module 1 — AI Resume Screening & Candidate Ranking**,
**Module 2 — Recruiter Copilot**, **Module 3 — Interview Intelligence &
Summaries**, **Module 4 — Company Knowledge Base + Employee HR Chatbot (RAG)**,
the AI surfaces of **Module 5 — Workforce Analytics Dashboard**, the AI surfaces of
**Module 6 — Employee Skill Graph**, **Module 7 — Attrition Prediction Engine**
(transparent cold-start scorer + SHAP + advisory LLM explanation), the AI surface of
**Module 8 — Internal Talent Marketplace / Internal Mobility** (move recommendation +
development plan), the AI surface of **Module 9 — Workflow Automation Engine**
(workflow draft authoring from a natural-language description), and the **capstone
Module 10 — Agentic HR Assistant** (an org-wide, role-aware ReAct orchestrator that calls
every prior module's capability as a governed tool) (spec Layer 2C + Layer 3A + Layer 4).

The wire contract is **camelCase end-to-end** and mirrors `@peopleos/schemas`
(`packages/schemas/src/*.ts`) exactly. The Pydantic models in `app/schemas.py` are the
Python side of that frozen contract. Primary LLM id: **`claude-sonnet-4-6`**.

Everything runs **fully offline** in dev: when `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
are absent, the LLM (holistic) and embedding (experience-relevance) steps fall back to
clearly-marked deterministic stubs, so the whole pipeline and the eval suite execute
with **no network**.

---

## Module 1 pipeline (LangGraph StateGraph)

```
ensure_jd_structured → skill_match → exp_relevance → yoe → mask_profile
  → holistic_llm (CoT; <thinking> split + stored for audit) → compose → bias_audit
```

Composite (spec step 5, weights configurable per org and must sum to 1.0):

```
final = skillMatch·0.35 + expRelevance·0.30 + holisticScore·0.25 + yoeMatch·0.10
```

Tiers by threshold on `finalScore`: **A ≥ 0.80**, **B ≥ 0.65**, **C ≥ 0.45**, else **D**.

**Privacy / bias (spec step 6 + prompt standard #4):** the profile is bias-masked
(name / contact / links / location removed, graduation years stripped, school names
redacted) **before** the holistic LLM step. **Chain-of-thought is audit-only** — it is
persisted server-side and **never** returned to end clients (the `CandidateRanking`
contract has no `reasoning` field).

---

## HTTP API

| Method + path                 | Request               | Response                                  |
|-------------------------------|-----------------------|-------------------------------------------|
| `GET  /health`                | —                     | `AiHealth`                                 |
| `POST /v1/resume/parse`       | `ParseResumeRequest`  | `ParseResumeResponse`                      |
| `POST /v1/jd/parse`           | `ParseJobDescriptionRequest` | `ParseJobDescriptionResponse`       |
| `POST /v1/ranking/score`      | `ScoreCandidateRequest` | `CandidateRanking` **+ sibling `reasoning`** |
| `POST /v1/ranking/score-batch`| `ScoreBatchRequest`   | `{ "rankings": [ {…CandidateRanking, "reasoning": "…"} ] }` |
| `POST /v1/audit/disparity`    | `DisparityRequest`    | `DisparityReport`                          |
| `POST /v1/copilot/jd-writer`  | `WriteJobDescriptionRequest` | `GeneratedJobDescription`           |
| `POST /v1/copilot/outreach`   | `GenerateOutreachRequest` | `OutreachResult`                       |
| `POST /v1/copilot/chat`       | `RecruiterChatRequest` | `RecruiterChatResponse`                   |
| `POST /v1/copilot/linkedin/analyze` | `AnalyzeLinkedInRequest` | `AnalyzeLinkedInResponse`         |
| `POST /v1/interview/analyze`  | `AnalyzeInterviewRequest` | `AnalyzeInterviewResponse`             |
| `POST /v1/interview/transcribe` | `TranscribeRequest`  | `TranscribeResponse` (or **503** — see below) |
| `POST /v1/policy/ingest`      | `PolicyIngestRequest` | `PolicyIngestResponse`                     |
| `POST /v1/embed`              | `EmbedRequest`        | `EmbedResponse`                            |
| `POST /v1/chat/answer`        | `ChatAnswerRequest`   | `ChatAnswerResponse`                       |
| `POST /v1/analytics/narrative`| `AnalyticsNarrativeRequest` | `AnalyticsNarrativeResponse`         |
| `POST /v1/analytics/ask`      | `AskDataRequest`      | `AskDataResponse`                          |
| `POST /v1/skills/growth-path` | `GrowthPathRequest`   | `GrowthPathResponse`                       |
| `POST /v1/skills/build-vs-buy`| `BuildVsBuyRequest`   | `BuildVsBuyResponse`                       |
| `POST /v1/attrition/score`    | `ScoreAttritionRequest` | `ScoreAttritionResponse`                 |
| `POST /v1/attrition/explain`  | `ExplainAttritionRequest` | `ExplainAttritionResponse`             |
| `POST /v1/mobility/recommend` | `MobilityRecommendRequest` | `MobilityRecommendResponse`           |
| `POST /v1/workflows/draft`    | `DraftWorkflowRequest` | `DraftWorkflowResponse`                   |

`/v1/ranking/score` and `/v1/ranking/score-batch` deliberately set **no
`response_model`** so the per-item sibling `reasoning` (audit-only CoT) survives the
response for the calling Node API to persist to `candidate_rankings.reasoning`. The API
strips `reasoning` before returning anything to end clients (prompt standard #3).

### Batch scoring (spec: "parallelised across applicant batch", < 8s/candidate)

`POST /v1/ranking/score-batch` fans candidates out with `asyncio.gather` under an
`asyncio.Semaphore` (size `batch_concurrency`, default **8** — see `app/config.py`),
reusing the exact per-candidate path. **One candidate failing does not sink the batch**:
its error is logged and that candidate is omitted from the result (the API can re-score
it individually / surface a `RankSkip`). Results preserve input order; the API sorts
best-first downstream.

### Disparity / bias audit (spec step 6, **pure statistics — no LLM**)

`POST /v1/audit/disparity` computes the EEOC **4/5ths rule** over scored candidates
tagged with an org-supplied demographic group label (never persisted here):

- per group: `n`, `selected` (tier ∈ `selectionTiers`, default A/B), `selectionRate`, `meanScore`
- `referenceGroup` = group with the highest selection rate
- `adverseImpactRatio` = min(selectionRate) / max(selectionRate) — `null` if max == 0 or < 2 groups
- `fourFifthsViolation` = ratio < 0.8
- `disproportionateFlag` = (max − min selectionRate) > 0.10

---

## Module 2 — Recruiter Copilot

Four AI surfaces under `app/copilot/`, all camelCase end-to-end (mirroring
`@peopleos/schemas` `copilot.ts`) and all applying the 7 prompt-engineering standards.
Every LLM-backed surface **degrades to a clearly-marked deterministic offline fallback**
when `ANTHROPIC_API_KEY` is absent, so the whole module runs with no network.

### 2a — JD Writer (`app/copilot/jd_writer.py`, prompt `app/prompts/jd_writer.py`)

`WriteJobDescriptionRequest → GeneratedJobDescription`. The XML-tagged prompt uses
`orgContext` for tone and the org's `priorJdExamples` as **tone-matched few-shot**, and
produces `summary / responsibilities / requirements / preferred / benefits /
deiStatement`. This module then **assembles `jdText`** (directly feedable to the Module 1
JD parser) and runs a deterministic **inclusive-language pass**
(`app/copilot/inclusive_language.py`) over the assembled text: it flags
gendered / exclusionary / age / ableist / jargon phrasing with a suggested alternative
each (`InclusiveLanguageReport.flagged`) plus a `biasCheck`. The inclusive-language pass
is intentionally rule-based (not LLM) so the bias report cannot be hallucinated and is
reproducible in the audit log; "competitive salary/pay/…" is whitelisted so standard
benefits copy is not false-flagged.

### 2b — Outreach (`app/copilot/outreach.py`, prompt `app/prompts/outreach.py`)

`GenerateOutreachRequest → OutreachResult`. Personalised to the candidate's **concrete,
unmasked** profile (this is outreach to the real person — **not** bias-masked like Module 1
scoring; it references real resume details by design). Produces **one variant per
requested tone** (WARM / FORMAL / BRIEF), a LinkedIn InMail body, and extra
`subjectVariants` for A/B testing. A `biasCheck` is still produced by running the
inclusive-language scan over the generated copy.

### 2c — Recruiter Chat (`app/copilot/chat_agent.py` + `app/copilot/tools.py`)

`RecruiterChatRequest → RecruiterChatResponse`. A **bounded reason→act→observe ReAct
agent** (max `chat_max_iterations`, default **8**) using the **Anthropic SDK native
tool-use** (`tools` param + `tool_use` / `tool_result` blocks) via `call_llm_tools` in
`app/llm.py` — **not** langchain-anthropic. Tools:

| Tool | Behaviour |
|------|-----------|
| `search_candidates(query, jobId?)` | → POST `{peopleos_api_url}/internal/copilot/search-candidates` |
| `get_pipeline_stats(jobId)`        | → POST `…/internal/copilot/pipeline-stats` |
| `get_candidate(candidateId)`       | → POST `…/internal/copilot/candidate` |
| `summarise_candidate(candidateId)` | `get_candidate` + advisory LLM summary (no PII beyond the profile) |
| `draft_email(candidateId, intent)` | `get_candidate` + **reuses the 2b outreach generator** |
| `schedule_interview(…)`            | **STUB** — "Calendar integration not yet available" (Phase 2) |

The three callback tools POST to the Node API's internal endpoints with the header
**`x-internal-secret: {ai_service_secret}`** (server-to-server auth) and the **`orgId` in
the body**. The `orgId` comes from the chat **request, never from the model** — a
tenant-isolation guarantee (the LLM cannot cross orgs). Responses are validated against
the `Tool*Response` Pydantic models. The returned `toolTrace` carries only
`{ tool, ok, resultSummary }` (a short summary) — **never raw data dumps**.

**Offline** (no `ANTHROPIC_API_KEY`): the loop needs the model to choose tools, so a
clearly-marked stub answer is returned (`modelVersion: "offline_stub"`). Tests stub the
LLM + `httpx`, asserting the tool wrappers POST the right shape with the secret header.

### 2d — LinkedIn analysis (`app/copilot/linkedin.py`)

`AnalyzeLinkedInRequest → AnalyzeLinkedInResponse`. **Consent is mandatory** (the schema
requires `consent: true`). Converts the scraped profile into a structured
`CandidateProfile` (**reusing the resume pipeline's skill normalisation** — `Golang → Go`,
`React.js → React`), matches it against each supplied open role with the **existing
Module 1 `app/scoring/skill_match.py`** to produce `LinkedInRoleMatch[]`
(`matchScore / tier / skillMatchPct / topGaps`, sorted best-first), and adds a short
advisory AI summary + `biasCheck`. Roles supplied as `jdText` only are parsed first
(offline-capable); roles with no structured requirements are surfaced as a `topGaps`
note rather than given a fabricated score.

### Config (`app/config.py`)

Two settings added for 2c: `peopleos_api_url` (default `http://localhost:3001`) and
`ai_service_secret` (`str | None`, the `x-internal-secret` value), plus
`chat_max_iterations` (default 8). For Module 3: `whisper_model` (default `large-v3`)
and `transcription_enabled` (default `true`). For Module 4: `embedding_model`
(default `text-embedding-3-large`) and `embedding_dim` (default **1536**) — the fixed
vector length forced at both ingest and query time.

---

## Module 4 — Company Knowledge Base + Employee HR Chatbot (RAG)

Three AI surfaces in `app/knowledge/`, all **camelCase end-to-end** (mirroring
`@peopleos/schemas` `knowledge.ts`). **RAG faithfulness is central**: the chatbot
answers **only** from retrieved policy chunks; if the answer is not in the context it
**says so and escalates** rather than inventing policy.

### (A) Document (policy) pipeline (`app/knowledge/pipeline.py`, spec Layer 2C)

`POST /v1/policy/ingest` (`PolicyIngestRequest` → `PolicyIngestResponse`). Steps:

1. **Structural parse** — build an H1/H2/H3 section tree from headings (markdown
   `#`/`##`/`###`, numbered `1.` / `1.2` headings, and an ALL-CAPS plain-text heuristic
   when no markdown is present).
2. **Segment by section** with a `sectionPath` (e.g. `Employee Handbook > Benefits >
   Health > Eligibility`).
3. **Semantic chunking** (NOT fixed-size) — split at **section / paragraph** boundaries,
   pack paragraphs up to **`MAX_CHUNK_TOKENS` = 1200** with **`OVERLAP_RATIO` = 15%**
   token overlap carried from the previous chunk's tail; an oversized single paragraph is
   sentence-split. Each chunk emits `DocumentChunkData` with `sectionPath`,
   `charStart`/`charEnd` (offsets into the original text), `pageNumber` (**null** for
   text), `tokenCount`, and the chunk **embedding**.
4. **Embedding** — every chunk goes through the single `embed_documents` entrypoint (B).
5. **SimHash** — a 64-bit fingerprint (`compute_simhash`) of the whole document for
   dedup / version supersession (near-duplicate uploads → small Hamming distance).

The token budget uses a dependency-free, **conservative** estimator
(`app/knowledge/tokens.py`, ~4 chars / ~1.3 tokens-per-word, taking the max so it never
under-counts) so chunking runs with no tokenizer install.

### (B) Embeddings (`app/knowledge/embeddings.py`)

`POST /v1/embed` (`EmbedRequest` → `EmbedResponse`). `text-embedding-3-large` via the
OpenAI SDK, **forcing** the `dimensions` param to `settings.embedding_dim` (default
**1536**) so ingest-time and query-time vectors are **always the same length** (cosine
similarity requires it). The **same** `embed_documents` function backs both the pipeline
(A) and this route. **Offline** (no `OPENAI_API_KEY`): a **deterministic, L2-normalised
unit vector** of the same dim from token hashing (clearly marked — `model` suffixed
`+offline_fallback`, `EmbedBatch.offline = True`), so dev retrieval works with no network
and the same text always maps to the same vector.

### (C) RAG answer (`app/knowledge/chat.py`, prompt `app/prompts/hr_chat.py`)

`POST /v1/chat/answer` (`ChatAnswerRequest` → `ChatAnswerResponse`). The API does the
retrieval and passes `candidateChunks`; this surface generates the grounded answer. The
prompt applies the **7 standards** (XML-tagged, exact output schema, **≥ 2 few-shot**, a
required `biasCheck`, `PROMPT_VERSION`, a privacy guard) and instructs the model to:

- answer **only** from `candidateChunks`; if the answer isn't there, set low confidence,
  do **not** invent policy, and `escalate = true` with a reason;
- **cite every claim** via `Citation` (`docTitle` + `sectionPath` + `effectiveDate`,
  `docId` echoed from the source chunk);
- classify `intent` (`POLICY_QUESTION` / `ACTION_REQUEST` / `ESCALATE`);
- **personalise** with the employee's own `department` / `location` / `hireDate` **without
  exposing any other employee's data** (privacy guard, standard #7);
- emit a snake_case `topic` label (analytics) + `biasCheck`.

On top of the prompt, **deterministic backstops** guarantee safety/faithfulness:
**(1)** sensitive topics — **termination, harassment, salary dispute, discrimination**
(regex `detect_sensitive_topic`) — **always** force `escalate = true` + `sensitiveTopic`
+ `intent = ESCALATE`, even when a chunk is present; **(2)** citations referencing a
`docId` not in the provided chunks are **dropped**; **(3)** empty context or an
ungrounded policy answer forces a low-confidence escalation. Pydantic-validated with the
retry → human-review path. **Offline** (no `ANTHROPIC_API_KEY`): a clearly-marked
**extractive** fallback stitches the top chunks into the answer with citations and
**always escalates** at low confidence (it can't judge sufficiency), suffixing
`modelVersion` with `+offline_fallback`.

---

## Module 3 — Interview Intelligence & Summaries

Two AI surfaces under `app/interview/`, camelCase end-to-end (mirroring
`@peopleos/schemas` `interview.ts`). **Privacy is central**: interview transcripts are
highly sensitive — stored encrypted (S3 SSE-KMS), never plaintext; candidate **consent**
is required before any recording/processing; transcripts are retained per org policy
(default 90 days) then deleted (DSAR-supported). All privacy/retention/consent
**persistence** lives in the Node API + Prisma (`Interview.consentObtained`,
`transcriptStatus`, `transcriptRetentionDeleteAt`, `transcriptDeletedAt`,
`transcriptPath`); this service is **stateless** and only does inference.

### Analysis (`app/interview/analyze.py`, prompt `app/prompts/interview_analyze.py`)

`AnalyzeInterviewRequest → AnalyzeInterviewResponse`. **One coherent LLM pass** produces
all four spec steps:

1. **Competency extraction** — per detected Q/A: `CompetencyEvidence`
   (`question / answerSummary / behaviouralIndicators[] / competencyArea`, per-dimension
   **STAR** `situation/task/action/result ∈ [0,1]`, and `starCompleteness`).
2. **Structured scorecard** — for **each** template competency a `CompetencyScore` 1-5
   **with a VERBATIM `evidenceQuote`** from the transcript (prompt standard #2: **no score
   without an evidence quote**) + `rationale`; then `overallRecommendation`
   (`STRONG_YES/YES/NO/STRONG_NO`) + `confidence` + `keyReasons[]`.
3. **Executive summary** — a single string of **3 paragraphs** (`\n\n`-separated):
   background recap / performance highlights / concerns + next steps.
4. **Calibration flags** — from the **transcript** only: `LEADING_QUESTION` and
   `ILLEGAL_QUESTION` (off-limits: pregnancy, family planning, religion, age, nationality,
   marital status, health/disability, race, sexual orientation), each with `severity`, a
   grounded `evidenceQuote`, and `illegalTopic`. Panel **`SCORE_DIVERGENCE` is computed by
   the API**, not here.

The XML-tagged prompt carries the **output schema + ≥2 few-shot** and two hard guards:

- **Privacy guard (standard #7):** evaluate ONLY professional competencies; disregard
  personal disclosures the candidate volunteers (health/family/religion/…) and **never
  repeat them** in any output field. When flagging an illegal question, only the
  **interviewer's** question is quoted — never the candidate's protected answer.
- **Evidence guarantee (standard #2):** every competency score must cite a verbatim
  transcript quote. `_enforce_evidence_guarantee` is a structural backstop that back-fills
  a (redacted) transcript quote if the model ever returns an empty one, rather than
  persisting a score with no evidence.

Output is Pydantic-validated with the **retry → human-review** path (`validation.py`) and
carries a `biasCheck`. **Offline** (no `ANTHROPIC_API_KEY`): a clearly-marked
deterministic heuristic analysis (Q/A pairing by speaker role, keyword-based STAR +
competency signals, a regex scan for leading/illegal questions). The offline path applies
its **own** privacy redaction (`_redact_protected`) over candidate-derived text so the
volunteered disclosures never reach `answerSummary` / `evidenceQuote`; `modelVersion` is
suffixed `+offline_fallback`.

### Transcription (`app/interview/transcribe.py`)

`TranscribeRequest → TranscribeResponse` (a diarised `InterviewTranscript`). A
**self-hosted WhisperX large-v3 + speaker-diarisation** adapter — **NEVER OpenAI hosted
Whisper** (data privacy; interview audio must not leave our infrastructure). The heavy
GPU stack (`whisperx` + `torch`, the `transcription` optional-deps group) is **guarded**:
when the stack or audio is unavailable (this dev/CI environment), the adapter raises
`TranscriptionUnavailable`, which `app/main.py` maps to **HTTP 503**
(`code: TRANSCRIPTION_UNAVAILABLE`, `details.fallback: "submit_transcript"`) so the dev
path is **"submit a transcript"** (`SubmitTranscriptRequest`) instead. We **never
fabricate** a transcript — a hallucinated interview transcript is worse than none.

**Per-connector audio fetch is a documented TODO** (out of scope for this stateless
inference service — it belongs in the Node API / a worker): Zoom cloud-recording webhook →
download_url (S2S OAuth); Google Meet → Drive `files.get(alt=media)`; MS Teams → Graph
recording content; Upload → S3 (SSE-KMS) object. In all cases the audio is streamed to
the GPU host, transcribed, the transcript stored **encrypted**, and the audio deleted per
retention. See the module docstring for the production wiring reference.

---

## Module 5 — Workforce Analytics Dashboard (5e AI surfaces)

The dashboard **metrics are computed IN THE API** from Postgres (prod: scheduled **DBT
models in Snowflake** — documented, not built here). Multi-tenancy is enforced on every
metric query by the API; the AI service is **stateless** and has **no database access**.
The API passes the already-validated `DashboardMetrics` snapshot to the AI service, which
**narrates / answers grounded ONLY in that snapshot** — it never queries data and **never
generates SQL**. Sections **5c** (engagement/retention, needs Module 7 attrition + surveys)
and **5d** (skills/talent density, needs the Module 6 skill graph) **degrade gracefully**
in the snapshot (`available:false` + a `pendingReason`); the AI reports them as pending
rather than fabricating zeros.

The `metrics` field is accepted as an **opaque dict** on the AI side (`schemas.py`):
the API has already validated it against the strict Zod `DashboardMetrics`, so the AI
narrates/answers generically. `app/analytics/metrics_access.py` provides safe dotted-path
navigation, human formatters, rule-based anomaly detection, and the keyword→metric lookup.

### (A) AI narrative + anomalies (`app/analytics/narrative.py`, prompt `app/prompts/analytics_narrative.py`)

`POST /v1/analytics/narrative` (`AnalyticsNarrativeRequest` → `AnalyticsNarrativeResponse`).
Produces a **headline**, a **3-paragraph executive narrative** naming the period's most
important people metrics, a **`keyMetrics`** list (`label/value/note`), and **`anomalies`**
(each a `FlagSeverity`). The XML-tagged prompt applies the 7 standards (≥2 few-shot, exact
output schema, grounding constraint, privacy guard) and **grounds every number** in the
snapshot. Pydantic-validated with the shared retry → human-review path.

**Offline fallback** (no `ANTHROPIC_API_KEY`): a deterministic narrative templated from the
metrics, clearly marked `[OFFLINE SUMMARY]`, **plus rule-based anomalies** — WIDE (>8) /
NARROW (<3) span of control, SLA breaches (HIGH), stage conversion `< ~0.30`, offer
acceptance `< ~0.70`, new-hire success `< ~0.70`, and 0% promotion bottlenecks
(`app/analytics/metrics_access.py::detect_anomalies`). `modelVersion` is suffixed
`+offline_fallback`.

### (B) "Ask your data" (`app/analytics/ask.py`, prompt `app/prompts/analytics_ask.py`)

`POST /v1/analytics/ask` (`AskDataRequest` → `AskDataResponse`). Answers a natural-language
question (e.g. *"how many engineers do we have in Europe?"*) **using ONLY the supplied
metrics**. Returns the `answer`, **`usedMetrics`** (which metric keys it drew on — no free
SQL is generated), an **optional `ChartSpec`** (`BAR`/`LINE`/`PIE` built from the metrics)
when a chart aids the answer, and a `confidence`. If the needed metric is **not in the
snapshot** (e.g. a cross-tab the dashboard doesn't compute), it **says so plainly** and sets
`confidence: "low"` — it never fabricates a number.

**Offline fallback** (no `ANTHROPIC_API_KEY`): a deterministic **keyword → metric lookup**
over the snapshot (`lookup_answer`) with a templated, clearly-marked `[OFFLINE]` answer +
chart for the matched metric; an unmatched question returns the honest "not available in
this snapshot" answer at `confidence: "low"`.

Both surfaces stamp `promptVersion` (`module5.analytics_narrative@1.0.0` /
`module5.analytics_ask@1.0.0`) and use the primary LLM `claude-sonnet-4-6` at
`temperature=0.0` (grounded, not creative).

---

## Module 6 — Employee Skill Graph (6a AI growth path + 6c build-vs-buy)

The skill graph is modelled **relationally in Postgres** (Neo4j is the documented prod
adapter); graph queries (profiles, who-has-skill, team map / bus-factor, org inventory) are
computed **in the Node API via Prisma joins** with multi-tenancy on every query, and skill
confidence is always derived from the **source** (`confidenceForSource`: self 0.5 / manager
0.8 / assessment 0.9 / resume 0.6 / project 0.7 — never client-supplied). This stateless AI
service provides the **two AI-reasoning surfaces** on top of that graph, under `app/skills/`,
camelCase end-to-end (mirroring `@peopleos/schemas` `skills.ts`). Both **ground their
reasoning ONLY in the supplied skills / counts** and degrade to a **clearly-marked
deterministic offline fallback** when `ANTHROPIC_API_KEY` is absent.

### (A) Growth path (6a) — `app/skills/growth_path.py`, prompt `app/prompts/growth_path.py`

`POST /v1/skills/growth-path` (`GrowthPathRequest → GrowthPathResponse`). Given the
employee's current skills (`employeeSkills`), the `targetRoleTitle` + `targetRequiredSkills`,
and an optional `skillCatalog`, it produces *"You are **N** skills away from Senior ML
Engineer. Add MLOps and System Design to qualify."* — i.e. `stepsAway`, one
`recommendedSkill` per missing required skill (a short `why` + a `suggestedTraining`: a
catalog match where one exists, else a generic suggestion), a `summary`, a `confidence`, and
a `biasCheck`. The XML-tagged prompt applies the **7 standards** (≥3 few-shot, exact output
schema, grounding constraint, privacy guard, `PROMPT_VERSION`).

**Grounding is ENFORCED, not just instructed.** Regardless of what the model returns, the
surface recomputes **`stepsAway` from the actual set difference** (target-required skills the
employee lacks, case-insensitive, de-duplicated) and **forces the recommendations onto
exactly that set** — dropping any recommended skill that is not a genuine, still-missing
required skill (so it can **never** recommend a skill the employee already holds or one the
role doesn't require) and back-filling any missing skill the model omitted, so
`len(recommendedSkills) == stepsAway`. **Bias guard (standard #4):** the path is computed
**purely from the skill gap**, never from any protected attribute, and `biasCheck` is forced
to `biasIndicatorsDetected: []`, `correctionApplied: false`. **Privacy (standard #7):** the
prompt reasons only about *this* employee and never references another. Pydantic-validated
with the shared retry → human-review path. **Offline** (no `ANTHROPIC_API_KEY`): the same
deterministic set-difference path + templated recommendations, `summary` marked `[OFFLINE]`
and `modelVersion` suffixed `+offline_fallback`.

### (B) Build vs Buy (6c) — `app/skills/build_vs_buy.py`, prompt `app/prompts/build_vs_buy.py`

`POST /v1/skills/build-vs-buy` (`BuildVsBuyRequest → BuildVsBuyResponse`). Given a `skill`
with its `currentSupply`, `demand`, and `trainableInternally` counts, it recommends **BUILD**
(train internally), **BUY** (hire), or **HYBRID**, with a concise rationale grounded in the
supplied numbers. The **deterministic decision rule is the source of truth** for the verdict
(reproducible / auditable); the LLM supplies only the human-readable `rationale`, and **if
the model disagrees with the rule, the rule wins** (the model's prose is kept, annotated):

```
gap = max(0, demand − currentSupply)
  gap == 0                                 → BUILD   (no shortfall; deepen the bench)
  gap > 0 and trainableInternally ≥ gap    → BUILD   (internal pool can close the gap)
  gap > 0 and trainableInternally == 0     → BUY     (no internal pool to train)
  otherwise (0 < trainableInternally < gap)→ HYBRID  (train some, hire the remainder)
```

The XML-tagged prompt applies the **7 standards** (≥4 few-shot, exact output schema, the
rule encoded as the grounding constraint, privacy guard over the aggregate counts,
`PROMPT_VERSION`). Pydantic-validated with the shared retry → human-review path. **Offline**
(no `ANTHROPIC_API_KEY`): the same rule + a templated `[OFFLINE]` rationale, `modelVersion`
suffixed `+offline_fallback`.

Both surfaces stamp `promptVersion` (`module6.growth_path@1.0.0` /
`module6.build_vs_buy@1.0.0`) and use the primary LLM `claude-sonnet-4-6` at
`temperature=0.0` (grounded, not creative). **5d wiring note:** the analytics dashboard's
skills/talent-density section (`SkillsTalent` / `SkillGap` / `BusFactorRisk` in
`analytics.ts`) is fed by these graph computations in the Node API — until then it degrades
gracefully (`skills.available: false`) in the Module 5 metrics snapshot.

---

## Module 7 — Attrition Prediction Engine (transparent scorer + LLM explanation)

Two surfaces, both governed by the spec's ethics rules: the score is **ADVISORY ONLY**
(no automated HR action). Code lives in `app/attrition/`; the explanation prompt is
`app/prompts/attrition_explain.py`.

> **Governance boundary.** This service only computes scores + explanations from the
> features the API supplies. The role-gated views (managers see **tier + recommendation
> only**, never the raw score/SHAP/feature values; the score is **never shown to the
> employee**), the **opt-out** exclusion, and the **monthly bias audit** are enforced by
> the Node API + the frozen contracts — never here. The explanation surface receives only
> the tier + labelled drivers + a **non-PII** context, so it physically cannot leak the raw
> score. The monthly bias audit reuses the **Module 1 disparity engine**
> (`/v1/audit/disparity`, `app/audit/disparity.py`) over the tier distribution.

### (A) Scorer (`app/attrition/scorer.py`)

`POST /v1/attrition/score` (`ScoreAttritionRequest → ScoreAttritionResponse`). A
**transparent, deterministic cold-start logistic model** — the dev/offline default that
needs **NO network and NO API keys** (no LLM is involved). Per employee:

1. **Normalise** each `AttritionFeatures` field to a `[0,1]` signal where `1` == "more
   attrition-prone" (documented transform per feature: a saturating ramp for the
   "days-since-X" fields, the team rate passed through, a hump-shaped tenure curve, and a
   performance curve that peaks for **strong** performers — the spec's *regrettable* loss).
   A **missing (null) feature is NEUTRAL** — it sits at its baseline, contributes exactly
   `0`, and is **never imputed as risk**.
2. **Combine** via a logistic: `z = intercept + Σ weightₓ·(signalₓ − baselineₓ)`,
   `riskScore = sigmoid(z) ∈ [0,1]`. `_WEIGHTS` are documented priors (career stagnation +
   team instability dominate).
3. **Tier**: `CRITICAL ≥ 0.75`, `HIGH ≥ 0.5`, `MEDIUM ≥ 0.25`, else `LOW`.

Because the model is **linear in its contributions**, each feature's contribution
`weightₓ·(signalₓ − baselineₓ)` **IS** its exact SHAP value (the Shapley value of an
additive linear model is its own term), so `shapValues` (every feature) and `topDrivers`
(the largest-|contribution| features, each with a human `label` + `INCREASES`/`DECREASES`
direction) are **exact, not approximated**. The model uses **ONLY the provided features —
never a protected attribute** (none is in the feature set, weights, or normalisation), so
by construction the score cannot depend on age/gender/ethnicity/etc.

**Prod path (documented, guarded):** `_load_xgb_adapter` swaps in **XGBoost (+ LightGBM
ensemble)** trained on the org's own historical attrition (target `resigned_within_90_days`,
**min 200 labelled events**), **Platt-scaled** for calibrated probabilities, deployed via
**MLflow**, explained with **tree SHAP**. It activates only when `xgboost` + `shap` are
importable **and** `ATTRITION_MODEL_PATH` points at a trained artifact (false in dev/CI, so
the transparent logistic is used). Both paths return the identical `ScoredEmployee` shape,
so callers never branch. `modelVersion` is `module7.attrition.cold_start@1.0.0` (dev).

### (B) Explanation (`app/attrition/explain.py`, prompt `app/prompts/attrition_explain.py`)

`POST /v1/attrition/explain` (`ExplainAttritionRequest → ExplainAttritionResponse`). A
manager-facing **narrative + concrete recommended actions**, **grounded ONLY in the
supplied `topDrivers`** + the risk tier + a non-PII context. The XML-tagged prompt applies
the **7 standards** (≥2 few-shot, exact output schema, `PROMPT_VERSION`) and is constrained
to: never speculate beyond the drivers, **never infer personal circumstances** (health,
family, finances, "planning to leave" — privacy guard #7), **never reference a protected
attribute** (bias guard #4 — the `biasCheck` is forced empty regardless of model output),
and frame everything as **advisory** (supportive, retention-oriented actions only — never
discipline/PIP/adverse steps). Pydantic-validated with the shared retry → human-review path.
**Offline** (no `ANTHROPIC_API_KEY`): a deterministic templated narrative built from the
same drivers, clearly marked `[OFFLINE]`, `modelVersion` suffixed `+offline_fallback`.
`promptVersion` is `module7.attrition_explain@1.0.0`.

---

## Module 8 — Internal Talent Marketplace / Internal Mobility (move recommendation)

The internal-mobility **matching is SKILL-GRAPH driven and computed IN THE NODE API**, not
here: it reuses the **Module 6 `skillGap(employee, role)`** primitive to derive
`matchScore` (= skill **coverage**), a `readiness` tier (`READY_NOW` coverage ≥ ~0.9 & a
small gap / `READY_SOON` ≥ ~0.6 / else `STRETCH`), and the matched / missing skill sets —
the same primitive powering "recommended roles", "who can fill this role", the succession
bench, and the mobility analytics that feed Module 5's `internalMobilityRate`.

> **Governance boundary (enforced by the API, never here).** Flight-risk surfaced on
> internal candidates / successors is the **Module 7 attrition TIER only** (never the raw
> score) and is attached **only for ADMIN/HRBP viewers** (null for everyone else). An
> employee acts on their **own** behalf (apply / express interest) — the acting employee is
> resolved from the session principal. Multi-tenancy is on every match query. This
> stateless AI service receives only a single role's **non-PII** match (target role +
> matched/missing skills + readiness + a non-PII employee/org context); the raw match score
> is **not** passed in, so the generated text cannot leak it.

### Move recommendation (`app/mobility/recommend.py`, prompt `app/prompts/mobility_recommend.py`)

`POST /v1/mobility/recommend` (`MobilityRecommendRequest → MobilityRecommendResponse`).
Produces a concise advisory **`fitSummary`** for the internal move and a
**`developmentPlan`** — one **`DevelopmentStep`** (`skill` + a concrete `action` + an
optional `suggestedResource`) per **MISSING** skill. The XML-tagged prompt applies the
**7 standards** (≥3 few-shot, exact output schema, grounding constraint, privacy guard,
`PROMPT_VERSION`).

**Grounding is ENFORCED, not just instructed** (mirroring the Module 6 growth path).
Regardless of what the model returns, the surface **forces `developmentPlan` to cover
EXACTLY the missing skills**: it **DROPS** any step for a skill that is not a genuine
missing skill — including any **already-matched** skill the model wrongly turns into a step
or an **invented** one — and **BACK-FILLS** a templated step for any missing skill the model
omitted, so there is exactly one step per distinct missing skill in target-role order. So
it can **never** invent a skill the employee has or needs. **Bias guard (standard #4):** the
recommendation is computed **purely from the skill match**, never from any protected
attribute, and `biasCheck` is forced to `biasIndicatorsDetected: []`,
`correctionApplied: false` regardless of the model's self-report. **Privacy (standard #7):**
the prompt reasons only about *this* employee and never references another. Pydantic-validated
with the shared retry → human-review path. **Offline** (no `ANTHROPIC_API_KEY`): a
deterministic templated `fitSummary` (marked `[OFFLINE]`, readiness-aware) + one templated
step per missing skill, `modelVersion` suffixed `+offline_fallback`. `promptVersion` is
`module8.mobility_recommend@1.0.0`; the surface uses the primary LLM `claude-sonnet-4-6` at
`temperature=0.2` (advisory prose, kept grounded).

---

## Module 9 — Workflow Automation Engine (AI draft authoring)

The durable workflow **execution** engine is a **DB-persisted state machine in the Node
API** — the `WorkflowDefinition` / `WorkflowInstance` / `WorkflowTask` rows **are** the
durable state (Temporal is the documented prod substrate; no Temporal lives here). This
service provides the single **AI-authoring** surface on top of it.

### Workflow draft (`app/workflows/draft.py`, prompt `app/prompts/workflow_draft.py`)

`POST /v1/workflows/draft` turns a free-text **description** of an HR process into a
**runnable workflow draft** — `DraftWorkflowRequest` → `DraftWorkflowResponse`:

- a **name**, a **trigger** (`MANUAL` / `EVENT` / `SCHEDULED`) with an optional `eventType`
  (e.g. `EMPLOYEE_HIRED`, `RESIGNATION_SUBMITTED`), and
- an **ordered** list of typed **`WorkflowStep`** objects using **only** the allowed
  `StepType` vocabulary (`TASK` / `APPROVAL` / `NOTIFICATION` / `AI_TASK` / `TIMER` /
  `BRANCH`), with a realistic `assigneeRole` (`ADMIN` / `HRBP` / `MANAGER` / `EMPLOYEE`) and
  a positive `slaHours` on the **human** steps (`TASK` / `APPROVAL`), chained by a **linear
  `next`** (the last step's `next` is `null`).

The prompt follows the **7 standards** (XML-tagged system prompt; grounded in the allowed
enums; exact output schema; `promptVersion` stamped; bias/privacy guards — a workflow is
*process design*, never a decision about a person, so it routes by **role**, never by
individual) and ships **3 few-shot examples** mirroring the seeded onboarding / offboarding
templates.

**Grounding + repair is ENFORCED in code, not just instructed** (standards #2/#5). The model
output is parsed leniently (`_LenientStep` accepts a raw string `type`/`assigneeRole`) so a
stray value survives to be **repaired** rather than rejected, then `_repair_draft` makes the
draft runnable regardless of what the model returned:

- every step `type` is **coerced** to a valid `StepType` (an unknown type → `TASK`);
- every `assigneeRole` is **validated** against the allowed set (an invalid role is dropped;
  a **human** step with no/invalid role defaults to `HRBP`); human steps get a positive
  `slaHours` (default `48`) and **auto** steps have role + SLA cleared, mirroring the seed;
- step **ids are made unique** (a clash is suffixed) and the **next-chain is well-formed** —
  a dangling `next` (points at a missing id) is rewritten to the next step in document order
  and the **last step's `next` is forced to `null`** (terminal);
- `eventType` is cleared unless the trigger is `EVENT`.

The frozen `WorkflowStep` constructor at the end of the repair is the final guarantee the
emitted steps are contract-valid. The draft is a **starting point a human reviews + saves**;
it is **never auto-deployed**. Pydantic-validated with the shared retry → human-review path.
**Offline** (no `ANTHROPIC_API_KEY`): a clearly-marked deterministic **3–4 step template**
(`APPROVAL → [AI_TASK] → TASK → NOTIFICATION`, the `AI_TASK` added only when the description
implies generating content) with the trigger inferred from the description, `name` marked
`[OFFLINE]`, `confidence: "low"`, and `modelVersion` suffixed `+offline_fallback`.
`promptVersion` is `module9.workflow_draft@1.0.0`; the surface uses the primary LLM
`claude-sonnet-4-6` at `temperature=0.2`.

---

## Module 10 — Agentic HR Assistant (the capstone, `app/assistant/`)

`POST /v1/assistant/chat` is the **org-wide, ROLE-AWARE agent** that orchestrates **every
prior module's capability as a tool**. It generalises the Module 2c recruiter chat
(`app/copilot/`) to a **role-filtered, multi-module tool registry** running a bounded ReAct
loop (`AssistantChatAiRequest` → `AssistantChatAiResponse`).

### The security model (the whole point — do not weaken)

The agent must **never become a confused deputy**. Identity is the load-bearing invariant:

- `orgId` / `userId` / `role` come **only** from the trusted **`AssistantContext`**, set by
  the Node API from the **authenticated session** and relayed to this service. The agent
  attaches that context to **every** tool dispatch **programmatically** — the **LLM never
  sees it**, and a tool's `args` can **never** carry or override identity.
- Each tool's **`input_schema` declares ONLY its own args** (`jobId`, `employeeId`, …) — it
  **never** contains `orgId` / `userId` / `role`. `dispatch()` additionally **strips** any
  identity keys a prompt-injected model tries to smuggle into `args` before sending, so they
  can never shadow the trusted context.
- `dispatch(tool, args, context)` **POSTs** a `ToolInvokeRequest { tool, args, context }` to
  the API at **`/internal/assistant/tool`** with the **`x-internal-secret`** header
  (`timingSafeEqual`, fail-closed when `AI_SERVICE_SECRET` is unset — the same posture as the
  Module 2c `/internal/copilot/*` dispatcher).
- The **API dispatcher is the authoritative allowlist**: it **re-derives** the per-tool role
  gate from `context.role` and **re-runs each module's own governance** (attrition tier-only
  for managers, `get_attrition_summary` for HRBP/ADMIN only, employees see only their own
  data, …). A disallowed tool returns **`ok:false`** there. The agent's `tools_for_role`
  filter (below) is **defence in depth**, not the boundary — a bug in it can only ever *show*
  a tool the dispatcher then refuses.

### Tool registry + role filter (`app/assistant/tools.py`)

The registry mirrors the **frozen** `AssistantTool` vocabulary (`assistant.ts`) and its
server-side role gates exactly:

| Role group | Tools |
|---|---|
| **all roles** | `answer_policy_question`, `raise_hr_ticket`*, `get_my_skill_profile`, `get_skill_gap`, `recommended_roles`, `list_my_tasks` |
| **RECRUITER + HRBP + ADMIN** | `rank_candidates`, `draft_jd`, `generate_outreach`*, `find_internal_candidates` |
| **MANAGER + HRBP + ADMIN** | `get_employee_attrition` (own reports; tier + rec only), `get_team_skill_map` |
| **HRBP / ADMIN only** | `get_analytics_dashboard`, `ask_workforce_data`, `get_attrition_summary`, `get_succession`, `get_skill_inventory`, `draft_workflow`, `start_workflow`* |

`tools_for_role(role)` returns the Anthropic tools the model may use — so an **EMPLOYEE never
even sees** `get_attrition_summary`, and a **RECRUITER never sees it** either (it's
HRBP/ADMIN-only). `*` marks the **audited WRITE/action tools** (`raise_hr_ticket`,
`generate_outreach`, `start_workflow`): the system prompt requires the agent to **confirm
explicit user intent** in its reply before calling one.

### The ReAct loop (`app/assistant/agent.py`)

`run_assistant(req)` mirrors `chat_agent.py`: build the **role-aware system prompt**
(`app/prompts/assistant.py`, `module10.assistant@1.0.0`, the 7 standards, XML-tagged) +
`tools_for_role(req.context.role)`; thread `history` + `message` into the messages; loop
`call_llm_tools` **capped at `chat_max_iterations` (default 8)**. On `tool_use`, **dispatch
each tool with `req.context`** attached programmatically, append the `tool_result`, and
accumulate a **`ToolCallTrace { tool, ok, summary }`** per call — the trace carries only the
**short, non-sensitive summary** from `ToolInvokeResponse.summary`, **never** raw sensitive
output (structured `data` is fed back to the model as a `<data>` working-context block, not
into the trace). On `end_turn`, the `<thinking>` CoT is **stripped** (standard #3) and the
text is the reply. `suggestedActions` are **role-aware** (`app/assistant/suggestions.py`).

A single **tool error degrades to `ok:false`** and the loop continues (never crashes); the
loop is **capped** (a model that always asks for a tool hits the cap and returns a bounded
"reached my step limit" reply). **Offline** (no `ANTHROPIC_API_KEY`): a graceful,
clearly-marked **`[OFFLINE]` tool-free reply** plus role-aware suggestions — never a fabricated
answer, never a crash.

---

## Running locally

Install (uses the spec-pinned stack — do not substitute libraries):

```bash
cd services/ai
pip install -e ".[dev]"          # add ",parsers" for PDF/DOCX/spaCy extraction
```

Run the API (offline — no API keys needed):

```bash
uvicorn app.main:app --reload --port 8088
curl localhost:8088/health
```

Optional env (`.env` at the repo root): `ANTHROPIC_API_KEY` enables the real holistic
LLM step; `OPENAI_API_KEY` enables real embeddings. Without them the deterministic
fallbacks are used and `modelVersion` is suffixed with `+offline_fallback`.

---

## Tests

```bash
cd services/ai
pytest                  # all unit tests (offline, no network)
pytest tests/test_evals.py tests/test_disparity.py   # eval metrics + disparity audit
```

- `tests/test_ranker.py` — skill match, YoE, bias masking, tiers, validation/human-review,
  the offline single-score path, and **batch scoring** (order preservation + failure isolation).
- `tests/test_evals.py` — the eval metric functions (`precision_at_k`, `dcg/ndcg_at_k`,
  `selection_rate` + parity, `tier_relevance`) on tiny known inputs with exact values,
  plus the offline harness + gate.
- `tests/test_disparity.py` — synthetic data with a **known 4/5ths violation** and a
  **clean** case (exact assertions), plus the undefined-ratio edge cases.
- `tests/test_copilot.py` — **Module 2**: the JD writer / outreach / LinkedIn surfaces
  produce schema-shaped output via the offline fallback; the inclusive-language pass
  flags masculine-coded / age / exclusionary phrasing (and whitelists "competitive
  salary"); the chat tool wrappers POST the correct shape **with the `x-internal-secret`
  header** to the right internal endpoint (httpx stubbed) and `dispatch_tool` injects the
  request's `orgId` (never the model's); the ReAct loop runs a tool then answers (LLM
  stubbed); `schedule_interview` is a stub; and the LinkedIn matcher **reuses
  `score_skill_match`**.
- `tests/test_interview.py` — **Module 3**: the analysis surface produces **schema-valid**
  output via the offline fallback; **every `CompetencyScore` carries a non-empty
  `evidenceQuote`** (standard #2); an illegal-question transcript yields an
  `ILLEGAL_QUESTION` flag (`illegalTopic = FAMILY_PLANNING`, grounded in the
  **interviewer's** quote, not the candidate's answer); the **privacy guard** holds (a
  volunteered health disclosure never appears in any output field); and the transcribe
  adapter **degrades cleanly** (`TranscriptionUnavailable`) offline and when disabled.
- `tests/test_knowledge.py` — **Module 4**: the document pipeline produces **semantic
  chunks** that respect the **1200-token bound**, carry **~15% overlap** across
  boundaries, and record an **H1>H2>H3 `sectionPath`** (with accurate char offsets +
  `pageNumber = null`); the embed function is **deterministic offline** and emits vectors
  of the **fixed `embedding_dim`** (unit-norm, never all-zero); the **SimHash** is stable
  and gives near-duplicate docs a small Hamming distance; and the RAG chat answer **cites
  only provided chunks** (drops ungrounded citations), **escalates when context is empty**,
  and **escalates on a sensitive-topic query** (termination / harassment / salary dispute
  / discrimination) — all via the offline fallback + deterministic backstops.
- `tests/test_skills.py` — **Module 6**: the **growth path** computes `stepsAway` as the
  exact **set difference** offline (case-insensitive, de-duplicated) and **never recommends
  an already-held skill**; on the LLM path (stubbed) grounding is **ENFORCED** — a model that
  inflates `stepsAway`, invents a non-required skill, or re-recommends a held skill is
  corrected back to the true missing set (`len(recommendedSkills) == stepsAway`) and the
  `biasCheck` is forced clean; the **build-vs-buy** rule returns **BUILD / BUY / HYBRID** per
  the spec rule offline, and on the LLM path the **rule overrides** a disagreeing model
  verdict (keeping its prose) while leaving an agreeing rationale untouched.
- `tests/test_attrition.py` — **Module 7**: the scorer is **deterministic + reproducible**
  and **monotonic** in the intuitive direction (more time-since-promotion / higher team
  attrition / a manager change → higher risk); the **tier thresholds** are exact
  (`CRITICAL ≥ 0.75`, `HIGH ≥ 0.5`, `MEDIUM ≥ 0.25`, else `LOW`); `topDrivers` reflect the
  **largest |contribution|** with the correct direction; `shapValues` are **faithful**
  (`intercept + Σ shapValues` recovers `logit(riskScore)`); a **typical employee is LOW**
  and an all-bad one is **CRITICAL**; **null features are neutral** (zero contribution,
  excluded from `topDrivers`, and a missing promotion date is **not** treated as a stale
  one); and **no feature is a protected attribute**. The explanation surface (offline path)
  **grounds only in the supplied drivers** (no driver-not-present feature in the narrative),
  treats a `DECREASES` driver as a **mitigating factor**, emits only **supportive** actions
  (never PIP/discipline/termination), and **never emits a protected attribute** (the
  `biasCheck` is forced clean).
- `tests/test_mobility.py` — **Module 8**: the **move recommendation** produces a
  clearly-marked offline `fitSummary` + **exactly one development step per missing skill**
  (READY_NOW with no gap → an **empty plan**, nothing invented; duplicate missing skills are
  de-duped to one step); on the LLM path (stubbed) grounding is **ENFORCED** — a model that
  **invents** a skill or turns an **already-matched** skill into a step has those steps
  **dropped**, an **omitted** missing skill is **back-filled**, the plan covers **exactly**
  the missing skills in order, and the `biasCheck` is **forced clean** even when the model
  self-reports a bias indicator.
- `tests/test_workflows.py` — **Module 9**: the **workflow draft** offline fallback builds a
  clearly-marked valid 3–4 step template (`APPROVAL → TASK → NOTIFICATION`, an `AI_TASK`
  added when generation is implied) and **infers an `EVENT` trigger** from a "when X happens"
  description; on the LLM path (stubbed) grounding/repair is **ENFORCED** — an **invalid step
  type** is coerced to a valid `StepType`, an **invalid `assigneeRole`** is dropped and a
  role-less **human** step is defaulted (with a positive `slaHours`), **duplicate ids** are
  made unique, a **dangling `next`** is rewritten and the **last step forced terminal**, an
  **invalid trigger** is coerced, and `eventType` is cleared for a non-`EVENT` trigger. A
  shared `_assert_well_formed` invariant checks every draft only ever surfaces valid step
  types + roles, unique ids, and a well-formed next-chain.
- `tests/test_assistant.py` — **Module 10**: the **role filter** is pinned against the frozen
  `assistant.ts` vocabulary — an **EMPLOYEE** sees only the self-service set (**never**
  `get_attrition_summary`), a **RECRUITER never gets it either**, a **MANAGER** gets
  own-report `get_employee_attrition` but **not** the org-wide summary, and **HRBP/ADMIN** get
  the full governed set. The **anti-confused-deputy invariant** is enforced: **no tool's
  `input_schema` declares `orgId`/`userId`/`role`**, building such a schema **raises**, and
  `dispatch` **attaches the trusted context** + **strips smuggled identity keys** a
  prompt-injected model puts in `args` (the `ToolInvokeRequest` carries the real org/user/role,
  the evil ones are dropped) and sends the `x-internal-secret` header to
  `/internal/assistant/tool`. Governance is **independently re-checked** in `dispatch` (an
  EMPLOYEE calling `get_attrition_summary` is refused **without any network call**; the Node
  dispatcher's own `ok:false` is surfaced), a **tool error degrades to `ok:false` without
  crashing the loop**, the **loop is capped** (an always-tool model stops at exactly the cap),
  the `<thinking>` CoT is **stripped** from the reply, the trace carries only the **short
  summary** (no raw data dump), and **offline** returns a marked tool-free reply.

---

## Evals (spec Layer 6: Precision@3, NDCG, bias parity)

The golden set lives in `app/evals/golden_module1.json`:

- **`cases`** (≥ 12) — independent `profile` + `jd` + `expectedTier`, used for tier
  accuracy and a set-wide Precision@3.
- **`rankingCases`** — **job-level**: one JD scored against a set of candidates with an
  expected best-first order / expected tiers, so **Precision@3** and **NDCG@k** are
  meaningful within a single job; some candidates carry a `group` label for the
  **selection-rate parity** metric.

Run the eval report (offline, deterministic):

```bash
cd services/ai
python -m app.evals.run_evals            # human-readable report
python -m app.evals.run_evals --json     # machine-readable summary
```

Metrics reported: tier accuracy, within-1-tier accuracy, set-wide Precision@3,
job-level Precision@3, NDCG@5 (graded relevance from expected tier), and selection-rate
parity (the 4/5ths ratio across the golden group labels).

### CI eval gate (prompt-engineering standard #6)

Run the gate (exits **non-zero** if any metric is below its documented threshold):

```bash
cd services/ai
python -m app.evals.gate                 # dedicated gate entry point (recommended for CI)
python -m app.evals.gate --json          # also print the full JSON summary
# or, equivalently, via the runner:
python -m app.evals.run_evals --gate
```

Documented thresholds (`app/evals/run_evals.py::GATE_THRESHOLDS`) — tuned to the
**offline deterministic path** so CI gates without network; tighten once the real LLM
holistic step is wired (the gate then guards prompt regressions):

| Metric                  | Threshold | Meaning |
|-------------------------|-----------|---------|
| `withinOneTierAccuracy` | ≥ 0.80    | ranker stays within one tier of the label |
| `precisionAt3`          | ≥ 0.66    | set-wide top-3 dominated by good (A/B) labels |
| `rankingPrecisionAt3`   | ≥ 0.66    | each job-level shortlist top-3 mostly good |
| `ndcgAt5`               | ≥ 0.80    | job-level ranking quality (graded relevance) |
| `selectionRateParity`   | ≥ 0.80    | 4/5ths adverse-impact ratio across golden groups |

A metric that cannot be computed (e.g. parity with no group labels, or no ranking cases
present) does not fail the gate. Wire `python -m app.evals.gate` into GitHub Actions on
any PR touching `app/prompts/` or the ranker (spec Layer 6: "Eval runs in CI on every
prompt change before deployment").
