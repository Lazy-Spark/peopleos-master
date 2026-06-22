# @peopleos/web

Minimal **Next.js 14 (App Router)** skeleton for PeopleOS — the Phase 1 web
foundation, not the full ATS UI. It demonstrates the end-to-end wire path:
list jobs → open a job → see the **recruiter shortlist** → click **Screen all**
to run Module 1 batch candidate ranking, then review each candidate ranked
best-first with tier, score, sub-score breakdown, and explainability, and
**advance / reject** them in the pipeline.

It also includes the **Module 2 — Recruiter Copilot** UI surfaces:

- **2a · JD Writer** (`/copilot/jd`) — a brief form → `api.writeJd` → generated
  JD sections + inclusive-language flags (phrase → suggestion, by category) +
  bias check + a "copy / use as JD text" action.
- **2b · Candidate Outreach** — a "Draft outreach" button on each pipeline row
  → `api.outreach(applicationId)` → three tone variants (tabs), a LinkedIn
  InMail, and subject-line A/B options, each copyable.
- **2c · Copilot Chat** — a chat sidebar in the job pipeline view →
  `api.copilotChat(messages, jobId)` → the assistant answer + a compact tool
  trace (tool · ok · resultSummary). Non-streamed request/response.

(The LinkedIn sidebar — Module 2d — is the browser extension, not this app.)

It also includes the **Module 3 — Interview Intelligence & Summaries** UI:

- **Interview review** (`/interviews/[id]`) — a speaker-labelled, timestamped,
  collapsible **transcript**; the AI **scorecard draft** (each competency: 1-5
  score + verbatim evidence quote + rationale; overall recommendation +
  confidence + key reasons; the 3-paragraph summary; the per-answer STAR
  evidence); a **calibration** panel rendering leading-question, illegal-question
  (escalated, compliance-styled), and panel score-divergence flags; a **reviewer
  scorecard form** to confirm/override scores and submit; a **consent** indicator;
  and a **"Delete transcript (DSAR)"** control with confirm.

It also includes the **Module 4 — Employee HR Chatbot (RAG over company
knowledge)** UI surfaces:

- **Employee HR Assistant** (`/hr-chat`) — a chat conversation → `api.askHrChat`
  → a grounded answer rendered **with its citations** (policy title · section ·
  effective date · "View full policy →"), an **escalation banner** + HR ticket id
  when the question is escalated to a human, and **thumbs up/down** feedback per
  answer (`api.sendChatFeedback`). The `sessionId` is maintained across turns.
- **Policies** (`/policies`, HRBP/ADMIN) — upload a policy (title, doc type,
  effective date, raw text) → `api.ingestPolicy` (shows the indexed **chunk
  count**), a live list of policy documents (title / type / version / status /
  effective date), and an **Archive** action (`api.deletePolicy`).

It also includes the **Module 5 — Workforce Analytics Dashboard** UI:

- **Analytics** (`/analytics`) — the workforce health dashboard. It composes the
  API-computed `DashboardMetrics` snapshot (`api.getAnalyticsDashboard`) with the
  weekly AI **narrative** (`api.getAnalyticsNarrative`) and an **"Ask your data"**
  natural-language query (`api.askAnalytics`). Sections: the **recruiting funnel**
  (5a — by-stage funnel + conversion rates, time-to-fill / time-to-hire /
  offer-acceptance KPI tiles, source-of-hire, and an overdue **SLA-breach** list),
  **workforce composition** (5b — headcount bar charts by department / location /
  level, employment-type split, a **span-of-control** table flagging wide / narrow
  managers, promotion-rate-by-level, and new-hire success), **engagement** (5c) and
  **skills** (5d) which render an "Unlocks with Module 7 / Module 6" placeholder
  (from the contract's `available: false` + `pendingReason`) until those modules
  land, the **AI narrative** panel (headline + 3-paragraph narrative + key metrics
  + severity-coloured anomalies, 5e), and **"Ask your data"** (5e — answer +
  `usedMetrics` + a returned `ChartSpec` rendered via Recharts BAR/LINE/PIE).

It also includes the **Module 6 — Employee Skill Graph** UI surfaces (the skill
graph is modelled relationally in Postgres and queried in-API; the UI is typed
off `@peopleos/schemas`):

- **6a · Employee skill profile** (`/employees/[id]/skills`) — skills grouped by
  category as `SkillBadge`s, each with a **confidence indicator** (a dot sized +
  coloured by the source-derived `confidenceScore`); an **"add skill"** self-report
  control (records SELF_REPORTED at 0.5 confidence server-side); and an AI
  **growth-path** panel (pick a target role → `stepsAway` + `recommendedSkills`
  with rationale + suggested training, plus the API-computed gap).
- **6b · Team skill map** (`/skills/team`) — a members × skills **heatmap** (cell =
  proficiency, hover = confidence) with **bus-factor** flags (skills held by only
  one report) and **bench-strength** highlighted.
- **6c · Org skill inventory** (`/skills/inventory`) — the org supply / demand /
  gap **table** (gapped skills first) with an AI **"Build vs buy"** action per
  gapped skill, plus the **talent-density index**.
- **6d · Skill verification** — a manager **"Verify"** control on each unverified
  skill record (→ MANAGER_VERIFIED at 0.8 confidence), shown to ADMIN / HRBP /
  MANAGER (the API is the real authorisation boundary).

It also includes the **Module 7 — Attrition Prediction Engine** UI surfaces.
**Governance is central** and is reflected throughout the UI copy: the risk score
is **advisory only** (no automated HR action), it is **never shown to the
employee**, **managers see only the tier + recommendation** (never the raw score,
the SHAP drivers, or the feature values), and employees can **opt out** of being
profiled entirely. The model uses only tenure / performance / team / skill
signals — never a protected attribute — and a monthly **bias audit** checks
tier-distribution disparity across demographic groups. All wire shapes are typed
off `@peopleos/schemas`; the API is the role-gating / tenant boundary.

- **People-ops view** (`/attrition`, HRBP / leadership) — the full surface:
  - a **"Run scoring"** action (`api.runAttritionScoring`) that re-scores the org
    (honouring opt-outs) and shows the run summary (scored / skipped opted-out /
    model version);
  - the **overview** counts — scored, opted-out, **regrettable** (strong
    performers at high risk), and the at-critical/high flight-risk headcount —
    plus the **risk distribution** by tier;
  - the **risk heatmap** (`AttritionHeatmap`) across DEPARTMENT / LEVEL / TEAM,
    each cell shaded by tier severity (CRITICAL red → LOW green) with intensity
    scaled by the headcount — aggregate counts only, never individual scores;
  - the **flight-risk roster** (`FlightRiskList`, CRITICAL/HIGH only) built from
    the full `AttritionEmployeeView` reads, each drilling down into the **drivers**
    (`DriverList`, SHAP-style, HR-only), the **AI narrative**, the **raw score**
    (HR-only), and the **recommended actions**;
  - the monthly **bias-audit panel** (`BiasAuditPanel` → `api.attritionBiasAudit`),
    which reuses the Module 1 disparity engine: paste an org-supplied
    `employeeId → group` mapping (never persisted) → the `DisparityReport` with the
    EEOC 4/5ths ratio and the >10pp disproportionate-flagging flag.
- **Manager view** (`/attrition/team`, manager) — the manager enters their direct
  reports' employee IDs and sees the **redacted `ManagerAttritionView`** per
  report: the **risk tier** + **suggested talking points ONLY**. It renders **no
  numeric score, no SHAP, no feature values** — and even if a privileged caller
  received the full shape, it is down-rendered to tier + actions so the surface
  stays redacted.
- **Employee opt-out** (`/settings`) — an `OptOutToggle` (a settings switch →
  `api.setAttritionOptOut`) so the employee can exercise their right not to be
  profiled. When opted out, no score is computed or surfaced for them. The score
  itself is **never** shown to the employee; this toggle is the only attrition
  surface they see.

Small Module 7 components live in `components/attrition/`: `RiskTierBadge`
(severity-coloured, advisory; the only risk signal a manager ever sees),
`AttritionHeatmap`, `FlightRiskList`, `DriverList`, `OptOutToggle`, and the
`BiasAuditPanel`.

It also includes the **Module 10 — Agentic HR Assistant** UI (the capstone): an
org-wide, **role-aware** chat agent (`/assistant`) that orchestrates every prior
module's capability as a tool. The whole **security model is server-side** and is
reflected in the UI copy: the API derives the trusted identity context
(orgId / userId / role) from the authenticated session and relays it to the AI
ReAct loop, which attaches it to **every** tool dispatch — the agent can never act
outside the caller's role, read another tenant's data, or become a confused
deputy. The surface is a **chat thread** (user + assistant turns) with a
**collapsible tool-call trace** per assistant turn (e.g. *"Used:
get_attrition_summary, get_skill_inventory"*), role-aware **`suggestedActions`**
chips that **prefill** the next message, and a **session-history sidebar** scoped
to the caller's own conversations. An **optimistic** user bubble + a "working"
assistant placeholder render while the agent runs. Every wire shape is typed off
`@peopleos/schemas`; the API is the role-gating / tenant boundary and the
summarised `toolCalls` trace never carries raw, possibly-sensitive tool output.

## Stack

- Next.js 14 (App Router, React Server Components where sensible), TypeScript strict
- Tailwind CSS + a shadcn/ui baseline (`cn` helper + a single `Button`)
- `@tanstack/react-query` v5 for server state + the Rank mutation
- `recharts` v2 for the Module 5 analytics charts (funnel, headcount bars, pie/line)
- `@clerk/nextjs` v5 for auth/session (provider + middleware mounted; routes not gated yet)
- `date-fns` available for date formatting

All wire types come from **`@peopleos/schemas`** (workspace dependency). The app
never redeclares data shapes — the typed fetch client in `lib/api.ts` validates
every response against the canonical Zod contracts.

## Layout

```
app/
  layout.tsx          ClerkProvider + Query Providers + chrome
                      (nav → Assistant, Jobs, Analytics, Attrition, Skills, Team, Mobility, Workflows, JD Writer, Interviews, HR Assistant, Policies)
  providers.tsx       TanStack Query client
  page.tsx            dashboard stub → links to Jobs + Analytics + Attrition
  assistant/
    page.tsx          PeopleOS Assistant route shell (Module 10, the capstone)
    assistant-console.tsx  client: owns the conversation + running sessionId +
                      suggestedActions; session-history sidebar (own sessions) with
                      New chat + click-to-replay (getAssistantSession); optimistic
                      user bubble + "working" placeholder → api.assistantChat
  analytics/
    page.tsx          Workforce Analytics route shell (Module 5)
    analytics-dashboard.tsx  client: dashboard + narrative reads, composes all
                      5a–5e sections, formats metrics, lays out charts
  jobs/
    page.tsx          jobs list (Server Component, fetches via lib/api)
    [id]/
      page.tsx        job detail + recruiter shortlist + Copilot chat (Server Component)
      pipeline-list.tsx   client component: "Screen all" batch ranking +
                          best-first shortlist + advance/reject + outreach (2b)
  copilot/
    jd/
      page.tsx        JD Writer route shell (2a)
      jd-writer.tsx   client component: brief form → api.writeJd → JD render
  interviews/
    page.tsx          interviews index stub (entry point + privacy posture)
    [id]/
      page.tsx        interview review (Server Component): transcript + AI draft +
                      calibration + reviewer form + consent + DSAR delete (Module 3)
  hr-chat/
    page.tsx          HR Assistant route shell (Module 4)
    hr-chat-conversation.tsx  client: chat list + input → api.askHrChat,
                      citations + escalation banner + thumbs feedback, sessionId
  policies/
    page.tsx          Policies route shell (Module 4, HRBP/ADMIN)
    policies-manager.tsx  client: upload form + live policy list + archive
  employees/
    [id]/skills/
      page.tsx        employee skill profile route shell (6a, Server Component;
                      pre-fetches open roles for the growth-path picker)
      employee-skill-profile.tsx  client: profile read, skills by category +
                      confidence dots, add-skill self-report, per-record Verify,
                      growth-path panel
  skills/
    team/
      page.tsx        Team skill map route shell (6b; Suspense wrapper)
      team-skill-map.tsx  client: ?manager= → heatmap + bus-factor + bench strength
    inventory/
      page.tsx        Org skill inventory route shell (6c)
      skill-inventory.tsx  client: supply/demand/gap table + talent-density KPIs
  mobility/
    page.tsx          Internal job board route shell (Module 8a, employee)
    mobility-board.tsx  client: ?employee= → recommended roles (match+readiness)
                      + apply + browse open roles + my internal applications
    gigs/
      page.tsx        Gig/stretch marketplace route shell (8c, employee)
      gig-marketplace.tsx  client: recommended gigs + browse + express interest
                      + post-a-gig form (manager/HRBP → CreateGigRequest)
    analytics/
      page.tsx        Mobility analytics (8, HRBP/leadership; Server Component):
                      fill rate + mobility rate + by-department (MobilityAnalytics)
  jobs/[id]/
    internal-candidates/
      page.tsx        Internal candidates + succession (8b+8d, recruiter/HRBP;
                      Server Component): ranked candidates + succession bands;
                      flight-risk tier shown ONLY when the API supplies it
  workflows/
    page.tsx          Workflow templates route shell (Module 9)
    workflow-templates.tsx  client: definitions list (step DAG via StepList) +
                      Start (→ instance monitor) + AI "draft from description"
                      box (api.draftWorkflow → proposed step DAG, advisory)
    [id]/
      page.tsx        Instance monitor route shell (Module 9)
      instance-monitor.tsx  client: WorkflowInstanceDetail — status + current step
                      + task TIMELINE (overdue highlighted) + Cancel; polls while
                      RUNNING/WAITING so worker-tick transitions surface
    tasks/
      page.tsx        "My tasks" inbox route shell (Module 9)
      my-tasks.tsx    client: owns inbox read + completion mutation (TaskInbox
                      renders rows + approve/reject/mark-done → CompleteTaskRequest)
    monitor/
      page.tsx        Org workflow monitor route shell (Module 9, ADMIN/HRBP)
      monitor-dashboard.tsx  client: WorkflowMonitor — instances by status +
                      overdue-task count + recent instances; 403 → access notice
  attrition/
    page.tsx          People-ops attrition route shell (Module 7, HRBP/leadership;
                      advisory-only governance banner)
    attrition-dashboard.tsx  client: summary (counts + tier distribution + heatmap)
                      + Run scoring + flight-risk roster with per-employee drill-down
                      (drivers + narrative + raw score, HR-only) + bias-audit panel
    team/
      page.tsx        Manager attrition route shell (Module 7; redacted-view banner)
      manager-attrition-team.tsx  client: reports' IDs → ManagerAttritionView per
                      report — TIER + recommended talking points ONLY (no score/SHAP)
  settings/
    page.tsx          Employee settings route shell (Suspense wrapper)
    settings-view.tsx client: ?employee= → OptOutToggle (attrition opt-out)
components/attrition/        (Module 7 — Attrition Prediction Engine)
  risk-tier-badge.tsx       severity-coloured tier pill (CRITICAL→LOW), advisory;
                            the ONLY risk signal a manager ever sees (no score/SHAP)
  attrition-heatmap.tsx     groups × tiers grid, cell shaded by severity × count;
                            DEPARTMENT/LEVEL/TEAM — aggregate counts only
  flight-risk-list.tsx      CRITICAL/HIGH roster (off AttritionEmployeeView), tier
                            only in the list; drill-down for the rest (HR-only)
  driver-list.tsx           SHAP-style top drivers (label + direction + magnitude),
                            HR/ADMIN ONLY — never rendered for managers
  opt-out-toggle.tsx        client: employee opt-out switch → api.setAttritionOptOut
  bias-audit-panel.tsx      client: org-supplied demographic mapping (never stored)
                            → api.attritionBiasAudit → DisparityReport (4/5ths, >10pp)
components/skills/           (Module 6 — Employee Skill Graph)
  skill-display.ts          shared label/style maps + confidence helpers (off enums)
  skill-badge.tsx           one skill chip + ConfidenceDot (sized/coloured by score) (6a)
  add-skill-control.tsx     client: catalog picker + proficiency → api.addEmployeeSkill (6a)
  growth-path-panel.tsx     client: target role → api.getSkillGap → stepsAway +
                            recommendedSkills + training + bias check (6a)
  verify-skill-button.tsx   client: manager Verify (+ proficiency adjust) → api.verifySkill (6d)
  skill-heatmap.tsx         members × skills grid; bus-factor columns flagged (6b)
  inventory-table.tsx       supply/demand/gap rows + per-gap BuildVsBuyButton (6c)
  build-vs-buy-button.tsx   client: api.recommendBuildVsBuy → BUILD/BUY/HYBRID + rationale (6c)
components/mobility/         (Module 8 — Internal Talent Marketplace)
  readiness-badge.tsx       READY_NOW/SOON/STRETCH pill (off Readiness), advisory
  match-bar.tsx             skill-coverage matchScore [0,1] as a % bar (red→emerald)
  skill-gap-chips.tsx       matched (emerald) / missing (amber) skill chips
  internal-app-status-badge.tsx  InternalAppStatus pill (INTERESTED→HIRED/REJECTED)
  internal-candidate-list.tsx  ranked candidates: match + readiness + gap; flight-
                            risk tier badge ONLY when present (ADMIN/HRBP, tier-only)
  succession-view.tsx       bench KPIs + ready-now/ready-soon/stretch bands (8d)
  gig-card.tsx              client: one gig + Express interest (own behalf) (8c)
components/workflows/        (Module 9 — Workflow Automation Engine)
  status-badge.tsx          one pill for BOTH InstanceStatus (RUNNING→CANCELLED)
                            and TaskStatus (PENDING→OVERDUE), severity-coloured;
                            exports INSTANCE_STATUS_ORDER + INSTANCE_LABEL
  step-type-badge.tsx       StepType pill; colour distinguishes human (waiting)
                            steps from auto (inline) steps
  step-list.tsx             renders a WorkflowStep[] DAG (definition OR AI draft):
                            type/name/owner/SLA/next + BRANCH rules rendered
                            read-only (SAFE field/op/value — never eval'd client-side)
  task-timeline.tsx         per-instance WorkflowTask[] timeline: type/status/
                            assignee/due/outcome; overdue rows highlighted
  task-inbox.tsx            client (presentational): inbox rows + approve/reject
                            (APPROVAL) or mark-done (TASK) → CompleteTaskRequest;
                            parent owns the mutation
  task-display.ts           shared helpers: isTaskOverdue / formatDue / OUTCOME_LABEL
components/assistant/        (Module 10 — Agentic HR Assistant)
  assistant-thread.tsx      client (controlled): the chat surface — message list +
                            optimistic/"working" bubbles + suggestedActions chips +
                            composer; raises onSend (no data fetching here)
  message-bubble.tsx        one assistant/user turn (off AssistantMessageRole);
                            assistant turns carry the collapsible ToolTrace
  tool-trace.tsx            collapsible per-turn tool trace ("Used: toolA, toolB")
                            off ToolCallTrace (tool · ok · summary — summary only,
                            never raw tool output); a refused tool shown as failed
  suggested-actions.tsx     role-aware next-step chips; clicking PREFILLS the
                            composer (does not auto-send — writes confirm first)
  session-list.tsx          history sidebar (off AssistantSessionSummary): caller's
                            OWN sessions + New chat + active highlight
components/analytics/        (Module 5 — Workforce Analytics)
  kpi-tile.tsx              single headline metric tile (time-to-fill, headcount, …)
  funnel-chart.tsx          recruiting funnel: by-stage bars + conversion arrows (5a)
  headcount-bars.tsx        Recharts bar chart over HeadcountBucket[] (5b/5c/5d)
  span-of-control-table.tsx managers + direct reports, WIDE/NARROW flags (5b)
  narrative-panel.tsx       AI headline + narrative + key metrics + anomalies (5e)
  chart-spec-view.tsx       renders a model-returned ChartSpec (BAR/LINE/PIE) (5e)
  ask-your-data.tsx         client: NL question → api.askAnalytics → answer +
                            usedMetrics + chart + confidence (5e)
  pending-section.tsx       "Unlocks with Module 7 / Module 6" placeholder (5c/5d)
components/hr-chat/
  chat-bubble.tsx           one HR-chat turn: answer + citations + escalation
                            banner + thumbs up/down feedback (Module 4)
  citation-list.tsx         grounded-answer sources: policy · section · effective
                            date · "View full policy →" (Module 4)
  escalation-banner.tsx     "connecting you with a human" + HR ticket id (Module 4)
components/policies/
  policy-upload-form.tsx    client: title / docType / effectiveDate / rawText →
                            api.ingestPolicy → chunk count (Module 4)
components/interviews/
  transcript-view.tsx       speaker-labelled, timestamped, collapsible transcript
  scorecard-draft-view.tsx  AI draft: per-competency 1-5 + evidence + rationale,
                            overall rec + confidence + key reasons + 3-para summary
                            + per-answer STAR evidence + bias check
  star-bars.tsx             STAR completeness bars (S/T/A/R unit scores)
  calibration-flags.tsx     leading / illegal (escalated) / score-divergence flags
  consent-indicator.tsx     candidate-consent badge (consent is a precondition)
  reviewer-scorecard-form.tsx  client: edit 1-5 + overall → api.submitScorecard
  analyze-button.tsx        client: api.analyzeInterview → refresh
  delete-transcript-control.tsx  client: DSAR delete with two-step confirm
components/copilot/
  inclusive-flag-list.tsx  JD inclusive-language flags + shared BiasCheckNote (2a)
  tone-tabs.tsx            outreach tone tabs + shared CopyableField (2b)
  outreach-panel.tsx       inline pipeline-row outreach generator (2b)
  chat-message.tsx         one chat turn + ToolTrace (2c)
  chat-sidebar.tsx         job-scoped Copilot chat sidebar (2c)
components/ui/
  button.tsx          shadcn-style Button
  copy-button.tsx     clipboard copy with "Copied" confirmation (2a/2b)
  tier-badge.tsx      A→D ranking tier pill (green → red), advisory
  score-bar.tsx       labelled unit-score progress bar (sub-score breakdown)
  collapsible.tsx     native <details> disclosure (explainability sections)
lib/
  api.ts              typed fetch client (camelCase, validates with @peopleos/schemas)
                      — adds writeJd / outreach / copilotChat (Module 2),
                      createInterview / submitTranscript / analyzeInterview /
                      submitScorecard / getCalibration / deleteTranscript (Module 3),
                      and askHrChat / getChatSession / sendChatFeedback /
                      ingestPolicy / listPolicies / deletePolicy / listHrTickets
                      (Module 4), and getAnalyticsDashboard /
                      getAnalyticsNarrative / askAnalytics (Module 5), and
                      getEmployeeSkills / addEmployeeSkill / verifySkill /
                      getSkillGap / getTeamSkillMap / getSkillInventory /
                      recommendBuildVsBuy / whoHasSkill / listSkills (Module 6),
                      and runAttritionScoring / getAttritionSummary /
                      getEmployeeAttrition (returns the role-appropriate
                      AttritionEmployeeView | ManagerAttritionView, narrowed via
                      isFullAttritionView) / setAttritionOptOut /
                      attritionBiasAudit (Module 7), and getRecommendedRoles /
                      applyInternal / listInternalApplications /
                      updateInternalApplicationStatus / getInternalCandidates /
                      getSuccession / getMobilityAnalytics / listGigs / createGig /
                      expressGigInterest / getRecommendedGigs / getMobilityFit
                      (Module 8), and listWorkflowDefinitions /
                      getWorkflowDefinition / startWorkflow / listWorkflowInstances /
                      getWorkflowInstance / cancelWorkflowInstance /
                      listMyWorkflowTasks / completeWorkflowTask /
                      getWorkflowMonitor / draftWorkflow / emitWorkflowEvent
                      (Module 9), and assistantChat / listAssistantSessions /
                      getAssistantSession (Module 10 — the agentic assistant;
                      the client sends only the message + running sessionId, the
                      trusted orgId/userId/role context is server-derived)
  utils.ts            cn() helper
middleware.ts         Clerk middleware (no route gating yet)
```

## Recruiter shortlist (Module 1)

The job-detail page renders the candidate pipeline as a **ranked shortlist**:

- **Screen all** runs Module 1 batch ranking: `POST /api/v1/jobs/:id/rank`
  (`api.rankJob(jobId, stages?)` → `RankJobResponse`). It shows a loading state,
  stores the fresh result, and calls `router.refresh()` so the Server Component
  re-pulls persisted rows (stage + compact `Application.aiRanking`).
- Candidates are sorted **best-first**: by the fresh `finalScore` when a batch
  result is present, otherwise by the compact stored `aiRanking.score`
  (unranked candidates sort last).
- Each candidate shows a colour-coded **TierBadge** (A green → D red), the final
  **score** out of 100, and — once screened — a **sub-score breakdown**
  (`components.skillMatch ×0.35`, `expRelevance ×0.30`, `holisticScore ×0.25`,
  `yoeMatch ×0.10`) as `ScoreBar`s, plus collapsible **strengths / concerns /
  interview focus** and the **AI summary**.
- **Advance** (`→ INTERVIEW`) and **Reject** (`→ REJECTED`) call
  `api.updateApplicationStage` and refresh the list. These are the human-in-the-loop
  decisions; the AI tier/score never moves a candidate on its own.

The list baseline uses the compact `Application.aiRanking` (no sub-scores); the
fresh `RankJobResponse` supplies the richer per-candidate detail after screening.
`RankJobResponse.skipped` candidates (e.g. no parsed profile yet) are surfaced
inline with their reason.

## Recruiter Copilot (Module 2)

Three UI surfaces, all typed off `@peopleos/schemas` and validated by the
`lib/api.ts` fetch client. The client sends only recruiter-supplied inputs; the
API assembles the rest of each frozen request contract server-side (`orgId` from
the authenticated session, `orgContext`, the org's `priorJdExamples` for
tone-matched few-shot, and — for outreach — the candidate `profile` + job
context). Every response is parsed against the frozen output contract before it
reaches the UI.

| Surface | Method | Endpoint | Returns |
| --- | --- | --- | --- |
| 2a JD Writer | `api.writeJd(input)` | `POST /api/v1/copilot/jd` | `GeneratedJobDescription` |
| 2b Outreach | `api.outreach(applicationId)` | `POST /api/v1/applications/:id/outreach` | `OutreachResult` |
| 2c Chat | `api.copilotChat(messages, jobId?)` | `POST /api/v1/copilot/chat` | `RecruiterChatResponse` |

- **2a — JD Writer** (`/copilot/jd`): a brief form (role title, seniority,
  department, team context, hiring-manager notes) feeds `WriteJdInput` (a subset
  of `WriteJobDescriptionRequest`). The result renders the JD sections (summary,
  responsibilities, requirements, preferred, benefits, DEI statement), the
  **inclusive-language report** (`InclusiveFlagList`: each flag as
  `phrase → suggestion`, grouped by category — gendered / exclusionary / age /
  ableist / jargon / other), the **bias check** (`BiasCheckNote`, prompt
  standard #4), and a **copy / use as JD text** action over the assembled
  `jdText` (directly feedable to the Module 1 JD parser).
- **2b — Outreach**: each non-terminal pipeline row carries a **Draft outreach**
  button (`OutreachPanel`). It shows the three **tone variants** (`ToneTabs`:
  warm / formal / brief), the **LinkedIn InMail**, and the **subject-line A/B**
  options — each independently copyable — plus the bias check. Per the contract,
  outreach is personalised to the *real* candidate and is **not** masked (unlike
  Module 1 scoring); it references concrete resume details by design.
- **2c — Copilot chat**: a `ChatSidebar` in the job pipeline view sends the full
  conversation + the current `jobId` each turn. Assistant turns render the answer
  and a **compact tool trace** (`ToolTrace`: tool · ok · resultSummary) — a
  summary only, never raw data, per the `ChatToolInvocation` contract. The
  skeleton uses a plain non-streamed request/response (the spec notes SSE
  streaming for production).

## Interview Intelligence (Module 3)

The interview review surface (`/interviews/[id]`) is a Server Component that
fetches three things via the typed `lib/api.ts` client and composes the
presentational components, all typed off `@peopleos/schemas`:

| Action | Method | Endpoint | Returns |
| --- | --- | --- | --- |
| Get scorecard | `api.getInterviewScorecard(id)` | `GET /api/v1/interviews/:id/scorecard` | `InterviewScorecard` |
| Get transcript | `api.getInterviewTranscript(id)` | `GET /api/v1/interviews/:id/transcript` | `InterviewTranscript` |
| Create interview | `api.createInterview(input)` | `POST /api/v1/interviews` | `InterviewScorecard` |
| Submit transcript | `api.submitTranscript(id, t)` | `POST /api/v1/interviews/:id/transcript` | `InterviewScorecard` |
| Analyze (4 steps) | `api.analyzeInterview(id)` | `POST /api/v1/interviews/:id/analyze` | `AnalyzeInterviewResponse` |
| Submit scorecard | `api.submitScorecard(id, input)` | `POST /api/v1/interviews/:id/scorecard` | `InterviewScorecard` |
| Panel calibration | `api.getCalibration(applicationId)` | `GET /api/v1/applications/:id/calibration` | `PanelCalibration` |
| Delete transcript (DSAR) | `api.deleteTranscript(id)` | `DELETE /api/v1/interviews/:id/transcript` | `InterviewScorecard` |

As with Module 2, the client sends only reviewer-supplied inputs and the
resource id; the API fills the frozen request contracts server-side (`orgId`
from the session, the role's `scorecardTemplate`, the stored encrypted
transcript, `jobTitle`, `orgContext`) before calling the Python AI service, and
every response is validated against the frozen output contract.

What the page renders:

- **Transcript** (`TranscriptView`): the diarised, timestamped segments from
  self-hosted WhisperX, speaker-labelled (interviewer / candidate / unknown) and
  collapsible (long + sensitive, opened on demand). A best-effort fetch — a
  404/410 (never processed, retention-expired, or DSAR-deleted) renders an empty
  state, not a page error.
- **AI scorecard draft** (`ScorecardDraftView`): each competency as a 1-5 score +
  the **verbatim transcript evidence quote** (prompt standard #2 — no score
  without evidence) + rationale; the overall recommendation, confidence, and key
  reasons; the **3-paragraph summary**; collapsible per-answer **STAR** evidence
  (`StarBars`); and the **bias-check** envelope (standard #4). The draft is
  explicitly **advisory**.
- **Calibration** (`CalibrationFlags`): leading-question, illegal-question, and
  panel score-divergence flags. **Illegal/off-limits questions** (pregnancy,
  religion, age, nationality, …) are a compliance risk, so they are surfaced
  first and escalated to **HIGH-severity alert styling** with a banner regardless
  of the model's assigned severity. Score-divergence flags are derived from the
  API-computed `PanelCalibration.divergences` (> 2 points → debrief).
- **Reviewer scorecard form** (`ReviewerScorecardForm`): the human-in-the-loop
  decision. It seeds editable 1-5 scores + the overall recommendation from the AI
  draft (or a prior submission), the reviewer confirms/overrides, and submits via
  `api.submitScorecard`. The AI never moves a candidate on its own.

**Privacy (central to this module):**

- **Consent** (`ConsentIndicator`) is shown on the page. Consent to record +
  process is a *structural* precondition — the frozen
  `CreateInterviewRequest.consentObtained` is `z.literal(true)`, so an interview
  cannot be created without it (and `api.createInterview` sends `true`).
- Transcripts are **encrypted at rest** (S3 SSE-KMS), never stored in plaintext,
  and decrypted server-side only for an authorised reviewer; this app never
  persists transcript text client-side.
- Transcripts are **retained** per org policy (default 90 days) then deleted, and
  the **"Delete transcript (DSAR)"** control (`DeleteTranscriptControl`) supports
  on-demand deletion behind a two-step confirm. Deletion destroys only the raw
  transcript; the submitted scorecard is retained.

## Employee HR Chatbot (Module 4)

A RAG-over-company-knowledge chatbot plus the HRBP policy knowledge base. As
with the other modules, the API is the tenant/auth boundary and assembles the
frozen request contracts server-side; the web client sends only employee-/
author-supplied inputs, and every response is validated against the frozen
`@peopleos/schemas` output contract before it reaches the UI.

| Surface | Method | Endpoint | Returns |
| --- | --- | --- | --- |
| Ask the assistant | `api.askHrChat(input)` | `POST /api/v1/hr-chat/ask` | `AskResponse` |
| Resume a session | `api.getChatSession(id)` | `GET /api/v1/hr-chat/sessions/:id` | `ChatSessionHistory` |
| Rate an answer | `api.sendChatFeedback(messageId, feedback)` | `POST /api/v1/hr-chat/messages/:id/feedback` | — |
| Ingest a policy | `api.ingestPolicy(input)` | `POST /api/v1/policies` | `IngestPolicyResponse` |
| List policies | `api.listPolicies()` | `GET /api/v1/policies` | `PolicyDocument[]` |
| Archive a policy | `api.deletePolicy(id)` | `DELETE /api/v1/policies/:id` | `PolicyDocument` |
| List HR tickets | `api.listHrTickets()` | `GET /api/v1/hr-tickets` | `HrTicket[]` |

### Employee HR Assistant (`/hr-chat`)

A chat conversation UI (`HrChatConversation`, client) over the org's policy
knowledge base:

- **Grounded answers, always cited.** RAG faithfulness is central: the assistant
  answers *only* from retrieved policy chunks (the API does hybrid dense + BM25
  retrieval + cross-encoder re-rank, then Claude generates the answer). Every
  answer renders its **citations** (`CitationList`): for each source, the policy
  **title · section path · effective date** and a **"View full policy →"** deep
  link (`/policies/:docId`). If the answer isn't in policy, the assistant says
  so and offers escalation rather than inventing policy.
- **Escalation to a human.** When the answer is escalated — low confidence,
  repeated failed queries, or a **sensitive topic** (termination, harassment,
  salary dispute) — an `EscalationBanner` is shown beneath the answer with the
  **HR ticket id** the API opened. Sensitive matters are handed to an HRBP, not
  answered from policy text.
- **Per-answer feedback.** Thumbs up/down on each assistant answer
  (`api.sendChatFeedback`, keyed by message id) feeds answer-quality and
  unresolved-query analytics; the selected vote is reflected optimistically.
- **Session continuity.** The component pins the `sessionId` returned on the
  first answer and passes it back on every subsequent turn, keeping the
  conversational-memory window (the API maintains the 10-turn sliding window /
  24h TTL server-side). `api.getChatSession(id)` can replay a prior session.
- The client sends only the employee's `message` + the running `sessionId` and
  pins `channel: "WEB"`; `orgId` and the non-PII `employeeContext` (department /
  location / hire date — used to personalise e.g. regional PTO answers) are
  resolved server-side from the authenticated session.

### Policies (`/policies`, HRBP / ADMIN)

The policy knowledge base management surface (`PoliciesManager`, client):

- **Upload** (`PolicyUploadForm`): title, document type (`PolicyDocType` select),
  effective date, and the policy body (`rawText` for dev; production uploads a
  file → `fileUrl`). `api.ingestPolicy` runs the Layer 2C document pipeline
  server-side (structural parse → semantic chunking → embed + index → SimHash
  dedup/versioning) and the form shows the indexed **chunk count** (and whether a
  prior version was superseded). The submitted body conforms to the frozen
  `IngestPolicyRequest` (exactly one of `rawText` / `fileUrl`).
- **List**: the org's policy documents with **title / type / version / status
  (ACTIVE · SUPERSEDED · ARCHIVED) / effective date** and an indexed indicator.
- **Archive** (`api.deletePolicy`): soft-archives a document (status → ARCHIVED,
  chunks deactivated so the chatbot stops retrieving from it), behind a two-step
  confirm. Upload and archive share the `["policies"]` query so the list stays
  current.

Authorisation (HRBP/ADMIN only) and tenant scoping are enforced by the API.

## Workforce Analytics (Module 5)

The Workforce Analytics dashboard (`/analytics`) gives HR, People Ops, and
leadership a real-time view of workforce health. As with the other modules the
API is the tenant/auth boundary: it **computes every metric server-side** from
tenant-scoped Postgres (prod: scheduled DBT models in Snowflake) and the AI
service only **narrates / answers** over the supplied snapshot — grounded *only*
in those metrics, never inventing numbers, never generating SQL.

| Surface | Method | Endpoint | Returns |
| --- | --- | --- | --- |
| Dashboard snapshot | `api.getAnalyticsDashboard()` | `GET /api/v1/analytics/dashboard` | `DashboardMetrics` |
| AI narrative (5e) | `api.getAnalyticsNarrative()` | `GET /api/v1/analytics/narrative` | `AnalyticsNarrativeResponse` |
| Ask your data (5e) | `api.askAnalytics(question)` | `POST /api/v1/analytics/ask` | `AskDataResponse` |

`AnalyticsDashboard` (client) loads the snapshot and the narrative via TanStack
Query (the narrative is fetched only after the snapshot resolves, and a narration
outage degrades gracefully without breaking the metrics) and composes the
presentational components, all typed off `@peopleos/schemas`:

- **5a · Recruiting funnel** — a by-stage funnel (`FunnelChart`) with
  stage-to-stage **conversion rates**; KPI tiles (`KpiTile`) for time-to-fill,
  time-to-hire, offer-acceptance, and open roles (nullable metrics render `—`,
  never a misleading `0`); a **source-of-hire** bar chart; and an overdue
  **SLA-breach** list (roles open > the SLA threshold, most-overdue first, in red).
- **5b · Workforce composition** — headcount **bar charts** (`HeadcountBars`,
  Recharts) by department / location / level and an employment-type split; a
  **span-of-control** table (`SpanOfControlTable`) flagging **WIDE** (>8 reports)
  and **NARROW** (<3) managers (the flag is API-computed on the contract); a
  **promotion-rate-by-level** table (bottleneck detection); and **new-hire
  success** / **internal mobility** KPI tiles.
- **5c · Engagement & retention** and **5d · Skills & talent density** — these
  depend on not-yet-built modules (the **Module 7** attrition engine and the
  **Module 6** skill graph). The frozen contracts return `available: false` +
  a `pendingReason`, so the dashboard renders a tasteful **"Unlocks with Module 7
  / Module 6"** placeholder (`PendingSection`) instead of erroring. When those
  modules land and flip `available` to `true`, the section content lights up.
- **5e · AI narrative** — `NarrativePanel` renders the executive **headline**, the
  3-paragraph **narrative** ("the 3 most important people metrics"), the surfaced
  **key metrics**, and any **anomalies** (metric > 2σ from the org's own baseline)
  coloured by `FlagSeverity`. The model + prompt version are shown for audit.
- **5e · Ask your data** — `AskYourData` (client) takes a plain-English question
  (e.g. "how many ML engineers do we have in Europe?"), posts **only** the
  question (the frozen `AskDataApiRequest`; the API supplies the tenant-scoped
  metrics), and renders the **answer**, the **`usedMetrics`** keys it drew on
  (transparency — no free SQL), the returned **`ChartSpec`** via Recharts
  (`ChartSpecView`: BAR / LINE / PIE), and a **confidence** badge.

Production refresh cadence (per spec, documented not built): near-real-time for
recruiting (webhook-driven), daily for HRMS-sourced composition metrics, and
weekly for the AI narrative; export to PDF / CSV / Slack is also a production
concern handled server-side.

## Employee Skill Graph (Module 6)

The skill graph is modelled **relationally in Postgres** (Neo4j is the documented
prod adapter); every graph query (who-has, gap, team map, inventory) is computed
**in-API** via Prisma joins and **tenant-scoped server-side**. Skill confidence is
**always derived from the source** server-side via `confidenceForSource`
(self 0.5 / manager 0.8 / assessment 0.9 / resume 0.6 / project 0.7) — the web
client **never** sends a confidence or source. All wire shapes come from
`@peopleos/schemas`; every response is validated by the `lib/api.ts` fetch client.

| Surface | Method | Endpoint | Returns |
| --- | --- | --- | --- |
| 6a Profile | `api.getEmployeeSkills(id)` | `GET /api/v1/employees/:id/skills` | `EmployeeSkillProfile` |
| 6a Add skill | `api.addEmployeeSkill(id, req)` | `POST /api/v1/employees/:id/skills` | `EmployeeSkillProfile` |
| 6a Gap + growth | `api.getSkillGap(empId, roleId)` | `GET /api/v1/employees/:id/skill-gap?targetRoleId=` | `{ gap, growthPath }` |
| 6b Team map | `api.getTeamSkillMap(mgrId)` | `GET /api/v1/managers/:id/team-skill-map` | `TeamSkillMap` |
| 6c Inventory | `api.getSkillInventory()` | `GET /api/v1/skills/inventory` | `SkillInventory` |
| 6c Build vs buy | `api.recommendBuildVsBuy(skillId)` | `POST /api/v1/skills/:id/build-vs-buy` | `BuildVsBuyResponse` |
| 6d Verify | `api.verifySkill(recId, req)` | `POST /api/v1/skill-records/:id/verify` | `SkillRecordView` |
| Catalog | `api.listSkills()` | `GET /api/v1/skills` | `Skill[]` |
| Who-has | `api.whoHasSkill(skillId)` | `GET /api/v1/skills/:id/holders` | `WhoHasSkillResult` |

- **6a · Employee skill profile** (`/employees/[id]/skills`): a client component
  reads the `EmployeeSkillProfile`, groups records by `SkillCategory`, and renders
  each as a `SkillBadge`. The **confidence indicator** (`ConfidenceDot`) is the
  spec's "sized by proficiency confidence" — its diameter scales (6→12px) and its
  colour ramps amber → emerald with `confidenceScore`, and verified records carry a
  trust accent. **Add skill** (`AddSkillControl`) lets the employee self-report a
  catalog skill + proficiency (`AddEmployeeSkillRequest`); the API records it as
  SELF_REPORTED / 0.5 — which kicks off the verification flow. **Growth path**
  (`GrowthPathPanel`) lets the employee pick a target role (a `JobOpening`, whose
  `jdStructured.requiredSkills` is the bar); `api.getSkillGap` returns both the
  API-computed `SkillGapReport` (matched / missing / coverage) and the AI
  `GrowthPathResponse` (`stepsAway` + `recommendedSkills` with `why` + an optional
  `suggestedTraining`). The AI output is advisory: its `confidence` + `biasCheck`
  are surfaced (prompt standards).
- **6b · Team skill map** (`/skills/team`): a `?manager=` id resolves the team;
  `SkillHeatmap` renders members (rows) × skills (columns), each cell shaded by
  proficiency and labelled with confidence on hover. **Bus-factor** columns
  (skills held by exactly one report — `TeamSkillMap.busFactor`) are highlighted
  red, and the per-skill **bench strength** (holder count) is listed alongside.
- **6c · Org skill inventory** (`/skills/inventory`, HRBP / leadership):
  `InventoryTable` shows per-skill **supply** (# holders) vs **demand** (# open
  roles requiring it) and the API-computed **gap**, gapped skills first. Each
  gapped row carries an inline AI **Build vs buy** action (`BuildVsBuyButton` →
  `api.recommendBuildVsBuy` → BUILD / BUY / HYBRID + rationale; the API computes
  the trainable-internally count server-side). Headline KPIs include the org
  **talent-density index**.
- **6d · Skill verification**: `VerifySkillButton` is a single-click manager
  confirmation on each unverified record (→ MANAGER_VERIFIED / 0.8, optionally
  adjusting proficiency via `VerifySkillRequest`). It is shown to ADMIN / HRBP /
  MANAGER; the API enforces authorisation server-side. On success it invalidates
  the profile query so the badge re-renders with its new, higher confidence.

## Internal Talent Marketplace (Module 8)

The internal mobility surface helps employees discover internal roles + gigs
before they look outside, and helps recruiters / HRBP fill roles from within.
**Matching is skill-graph driven**: the API reuses the Module 6 `skillGap`
primitive to derive each `matchScore` (= skill coverage), the `readiness`
(`READY_NOW` / `READY_SOON` / `STRETCH`), and the matched / missing skills +
`gapSize` — the web client **never** computes a match, it only renders the frozen
contract values. All wire shapes come from `@peopleos/schemas`; every response is
validated by the `lib/api.ts` fetch client.

| Surface | Method | Endpoint | Returns |
| --- | --- | --- | --- |
| 8a Recommended roles | `api.getRecommendedRoles(empId)` | `GET /api/v1/employees/:id/recommended-roles` | `RecommendedRoles` |
| 8a Apply | `api.applyInternal(req)` | `POST /api/v1/internal-applications` | `InternalApplication` |
| 8a My applications | `api.listInternalApplications()` | `GET /api/v1/internal-applications` | `InternalApplicationView[]` |
| 8a Move status | `api.updateInternalApplicationStatus(id, status)` | `PATCH /api/v1/internal-applications/:id/status` | `InternalApplication` |
| 8b Internal candidates | `api.getInternalCandidates(jobId)` | `GET /api/v1/jobs/:id/internal-candidates` | `RoleMatchResult` |
| 8d Succession | `api.getSuccession(jobId)` | `GET /api/v1/jobs/:id/succession` | `SuccessionPlan` |
| Analytics | `api.getMobilityAnalytics()` | `GET /api/v1/mobility/analytics` | `MobilityAnalytics` |
| 8c List gigs | `api.listGigs()` | `GET /api/v1/gigs` | `Gig[]` |
| 8c Post gig | `api.createGig(req)` | `POST /api/v1/gigs` | `Gig` |
| 8c Express interest | `api.expressGigInterest(gigId)` | `POST /api/v1/gigs/:id/interest` | `void` |
| 8c Recommended gigs | `api.getRecommendedGigs(empId)` | `GET /api/v1/employees/:id/recommended-gigs` | `RecommendedGigs` |
| AI move-fit | `api.getMobilityFit(empId, jobId)` | `POST /api/v1/employees/:id/mobility-fit?jobOpeningId=` | `MobilityRecommendResponse` |

- **8a · Internal job board** (`/mobility`, employee): `MobilityBoard` (client)
  composes three reads — **"Recommended for you"** (skill-graph matched roles,
  each with a `MatchBar`, a `ReadinessBadge`, the matched / gap skill chips, and an
  **Apply** action gated by `alreadyApplied`), **Browse open roles**
  (`api.listJobs`), and **My internal applications** (status pipeline via
  `InternalAppStatusBadge`). Applying acts on the employee's **own behalf** — the
  client sends only the `jobOpeningId` (the frozen `CreateInternalApplicationRequest`);
  the API resolves the acting employee from the session and computes the
  `matchScore`. The employee in context is read from `?employee=` in this dev
  foundation (production: the Clerk session).
- **8c · Gig / stretch marketplace** (`/mobility/gigs`, employee): `GigMarketplace`
  (client) shows **recommended gigs** (skill-matched, with a `MatchBar` + gap
  chips), the **browse** listing, and a **post-a-gig** form (manager / HRBP →
  `CreateGigRequest`). **Express interest** (`GigCard`) acts on the employee's own
  behalf (only the gig id is POSTed) and — per spec — notifies HR without alerting
  the employee's manager.
- **8b + 8d · Internal candidates + succession** (`/jobs/[id]/internal-candidates`,
  recruiter / HRBP): a Server Component fetches the ranked internal candidates
  (`RoleMatchResult`) and the `SuccessionPlan`. `InternalCandidateList` ranks
  employees by skill match with readiness + gap; `SuccessionView` bands the bench
  into **ready now / ready soon / stretch** and flags roles with **no internal
  successors** (the talent-pipeline-health signal). **GOVERNANCE:** each candidate /
  successor's `flightRisk` is the **Module 7 attrition TIER only** (never the raw
  score), rendered via `RiskTierBadge` **only when the API supplies it** — the API
  returns it non-null **only to ADMIN / HRBP** viewers (null otherwise, so the badge
  simply does not appear).
- **Analytics** (`/mobility/analytics`, HRBP / leadership): a Server Component
  renders the `MobilityAnalytics` KPIs — **internal fill rate**, **internal
  mobility rate** (the source of Module 5's 5b `internalMobilityRate`), open
  internal roles, total internal applications, hired internally — plus the
  internal-hires-**by-department** breakdown. Null rates render as "—" (the UI
  never derives a number).
- **AI move-fit** (`api.getMobilityFit`): the API recomputes the skill-graph match
  for the `(employee, role)` pair and assembles the frozen `MobilityRecommendRequest`
  server-side (adding the **non-PII** `employeeContext` — role / level / department,
  **no name, no demographics** — and `orgContext`), then calls the Python AI service
  (`claude-sonnet-4-6`). Returns a grounded `fitSummary`, a `developmentPlan`
  (skill → action → suggested resource), a `confidence`, and a `biasCheck`
  (prompt standards).

**Mobility components** (`components/mobility/`): `ReadinessBadge`,
`MatchBar`, `SkillGapChips`, `InternalAppStatusBadge`, `InternalCandidateList`,
`SuccessionView`, and `GigCard`. Flight-risk reuses the Module 7 `RiskTierBadge`.

## Workflow Automation (Module 9)

The engine is a **durable, DB-persisted state machine over Postgres** (the dev
engine; Temporal is the documented prod execution substrate — the
`WorkflowDefinition` / `WorkflowInstance` / `WorkflowTask` rows **are** the durable
state). A definition is a **DAG of steps**; starting one creates an instance the
engine walks — running the **automatic** steps inline (`NOTIFICATION` / `AI_TASK` /
`BRANCH`) and **waiting** at each **human** step (`TASK` / `APPROVAL` / `TIMER`),
materialising a `WorkflowTask` for it. **All correctness properties live
server-side** (the API + worker tick): every transition is persisted (resumable),
the engine caps iterations + guards revisits (a `BRANCH` may point backwards),
branch conditions are evaluated by a **SAFE declarative comparator** over
`instance.context` (`field` / `op` / `value` — **never** `eval` / `new Function` /
template injection), and SLA timers + escalation are driven by the periodic tick.
The web app is a **pure consumer** of that engine — it renders state and submits
the frozen requests; it never evaluates a branch, computes a due date as truth, or
infers authorisation.

| Surface | Client call | API route | Response |
| --- | --- | --- | --- |
| Templates | `api.listWorkflowDefinitions()` | `GET /api/v1/workflows` | `WorkflowDefinition[]` |
| One template | `api.getWorkflowDefinition(id)` | `GET /api/v1/workflows/:id` | `WorkflowDefinition` |
| Start | `api.startWorkflow(id, req)` | `POST /api/v1/workflows/:id/start` | `WorkflowInstanceDetail` |
| Instances | `api.listWorkflowInstances()` | `GET /api/v1/workflow-instances` | `WorkflowInstance[]` |
| Monitor (one) | `api.getWorkflowInstance(id)` | `GET /api/v1/workflow-instances/:id` | `WorkflowInstanceDetail` |
| Cancel | `api.cancelWorkflowInstance(id)` | `POST /api/v1/workflow-instances/:id/cancel` | `WorkflowInstanceDetail` |
| My tasks | `api.listMyWorkflowTasks()` | `GET /api/v1/workflow-tasks/me` | `WorkflowTask[]` |
| Complete task | `api.completeWorkflowTask(id, req)` | `POST /api/v1/workflow-tasks/:id/complete` | `WorkflowTask` |
| Monitor (org) | `api.getWorkflowMonitor()` | `GET /api/v1/workflows/monitor` | `WorkflowMonitor` |
| AI draft | `api.draftWorkflow(description)` | `POST /api/v1/workflows/draft` | `DraftWorkflowResponse` |
| Emit event | `api.emitWorkflowEvent(req)` | `POST /api/v1/workflows/events` | `EmitEventResponse` |

- **Templates** (`/workflows`): `WorkflowTemplates` (client) lists the org's
  definitions, each with its trigger (Manual / Event / Scheduled) and an
  expandable **step DAG** (`StepList`), and a **Start** action that creates an
  instance and routes to its monitor. The **"Draft a workflow with AI"** box sends
  only a natural-language `description`; the API fills `orgId` + the AI `orgContext`
  server-side (the frozen `DraftWorkflowRequest`) and calls the AI service
  (`claude-sonnet-4-6`), returning a proposed `name` / `trigger` / step DAG with a
  `confidence`. The draft is **advisory** and is rendered read-only — nothing is
  persisted until a person confirms it.
- **Instance monitor** (`/workflows/[id]`): `InstanceMonitor` (client) renders the
  `WorkflowInstanceDetail` — status, current step, subject, timestamps, and the
  full **task timeline** (`TaskTimeline`) with **overdue tasks highlighted** — and
  offers **Cancel** (ADMIN / HRBP, enforced server-side). It **polls while the
  instance is in flight** (`RUNNING` / `WAITING`) so worker-tick transitions (SLA
  escalation, a timer firing, an auto step advancing) appear without a reload, and
  shows the read-only `instance.context` for transparency into why a branch was
  taken.
- **My tasks** (`/workflows/tasks`): `MyTasks` (client) reads the human
  tasks/approvals assigned to me **or my role** and completes them via `TaskInbox`
  — **Approve / Reject** on an `APPROVAL` (recording `TaskOutcome` APPROVED /
  REJECTED), a single **Mark done** otherwise (DONE), with an optional note
  (`CompleteTaskRequest`). The acting user + role are resolved server-side; the API
  **authorises** every completion (only the assignee / their role, or ADMIN /
  HRBP) — an unauthorised attempt surfaces as the mutation error.
- **Org monitor** (`/workflows/monitor`, ADMIN / HRBP): `MonitorDashboard` (client)
  renders the `WorkflowMonitor` — instance count tiles **by status**, the org-wide
  **overdue-task** count (highlighted when non-zero, the SLA-breach signal the tick
  escalates), and **recent instances** (each linking to its monitor). The view is
  role-gated server-side; a 403 renders an access notice rather than an error.

**Workflow components** (`components/workflows/`): `StatusBadge` (one pill for
both `InstanceStatus` and `TaskStatus`), `StepTypeBadge`, `StepList` (the step DAG,
incl. read-only BRANCH rules), `TaskTimeline`, `TaskInbox`, and the shared
`task-display.ts` helpers (`isTaskOverdue` / `formatDue` / `OUTCOME_LABEL`).

> **API pairing note.** Module 9 API routes are a sibling subtree; the client uses
> the conventional REST paths above (consistent with the rest of `/api/v1`).
> Collection reads unwrap the same `{ items: [...] }` envelope used elsewhere.
> Every response is parsed against the frozen `@peopleos/schemas` contracts — no
> wire shape is redeclared in the web app.

## Agentic HR Assistant (Module 10 — the capstone)

`/assistant` is the **PeopleOS Assistant**: one org-wide, **role-aware** chat
agent that orchestrates **every** prior module's capability as a tool. A ReAct
loop in the AI service calls the API's secret-authed `/internal/assistant/*`
dispatcher, which **re-enforces tenancy + per-tool role governance** from the
**trusted session context** — never from the agent's tool choice or arguments.

**The security model is entirely server-side, and the web client is built to
honour it:**

- The client sends **only** the user's `message` (+ the running `sessionId` to
  continue a conversation). It **never** sends an `orgId`, `userId`, or `role`.
  The API derives the trusted `AssistantContext` (orgId / userId / role) from the
  authenticated session and relays it to the AI, which attaches it to **every**
  tool dispatch **programmatically** — the LLM never sees it and tool args can
  never carry/override identity. The agent therefore **can never become a confused
  deputy**: a disallowed tool returns `ok: false` from the dispatcher, and that is
  surfaced in the trace (shown as **refused**), not hidden.
- The **tool-call trace** is rendered from the frozen `ToolCallTrace`
  (`tool · ok · summary`) — a **summary only** by contract. The raw, possibly
  sensitive tool output never crosses the wire, so there is nothing for the client
  to redact.
- The **`suggestedActions`** chips are computed server-side from the caller's
  trusted role (a manager sees different chips than an HRBP). Clicking a chip
  **prefills** the composer rather than auto-sending — the user stays in control,
  and for write tools (`raise_hr_ticket`, `start_workflow`, `generate_outreach`)
  the agent still **confirms intent** before acting.

**The surface** (`AssistantConsole`, client):

- a **chat thread** (`AssistantThread`) of user + assistant turns; each assistant
  turn carries a **collapsible tool trace** (`ToolTrace`, e.g. *"Used:
  get_attrition_summary, get_skill_inventory"*) you can expand to see each tool's
  ok/refused status + summary;
- the running **`sessionId`** — omitted on the first turn (the API mints one and
  returns it), then passed back on every subsequent turn to continue the
  conversation;
- a **session-history sidebar** (`SessionList`) of the caller's **own** sessions
  (`api.listAssistantSessions`), newest-first, with **New chat** and
  **click-to-replay** (`api.getAssistantSession` loads the full transcript);
- an **optimistic** user bubble + a **"working"** assistant placeholder while the
  agent runs (send is disabled in flight so turn order stays correct); on error
  the placeholder is dropped so the user can retry cleanly; on success the
  sidebar is invalidated so a new/re-titled session appears.

**Endpoints** (typed off `@peopleos/schemas`, validated on the way back):

- `POST /api/v1/assistant/chat` → `assistantChat(AssistantChatRequest)` →
  `AssistantChatResponse` (`sessionId`, `reply`, summarised `toolCalls`,
  `suggestedActions`).
- `GET /api/v1/assistant/sessions` → `listAssistantSessions()` →
  `AssistantSessionSummary[]` (unwraps the shared `{ items }` envelope).
- `GET /api/v1/assistant/sessions/:id` → `getAssistantSession(id)` →
  `AssistantSessionDetail` (the session + its persisted `AssistantMessage[]`).

**Assistant components** (`components/assistant/`): `AssistantThread`,
`MessageBubble`, `ToolTrace`, `SuggestedActions`, `SessionList`.

> **API pairing note.** Module 10 API + AI routes are a sibling subtree; the
> client uses the conventional REST paths above (consistent with the rest of
> `/api/v1`, mirroring the `/hr-chat` and `/copilot` chat surfaces). Collection
> reads unwrap the same `{ items: [...] }` envelope used elsewhere. Every response
> is parsed against the frozen `@peopleos/schemas` contracts — no wire shape is
> redeclared in the web app.

## How to run locally

From the **repo root** (pnpm + turbo monorepo):

```bash
pnpm install            # installs all workspace deps (run once, from root)
```

Configure environment. The app reads:

| Var | Purpose | Example |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | Fastify API base URL | `http://localhost:3001` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key | `pk_test_...` |
| `CLERK_SECRET_KEY` | Clerk secret (server) | `sk_test_...` |
| `NEXT_PUBLIC_DEV_ORG_ID` | **dev only** — org UUID forwarded as `X-Org-Id` for RLS | a seed org id |

These are already named in the repo-root `.env.example`. For local web-only dev,
create `apps/web/.env.local` with at least `NEXT_PUBLIC_API_URL`, the Clerk keys,
and (to exercise tenant data before Clerk-derived org resolution lands)
`NEXT_PUBLIC_DEV_ORG_ID` set to a seeded organisation id from `prisma/seed.ts`.

Then, from the repo root:

```bash
pnpm --filter @peopleos/web dev        # http://localhost:3000
```

Or run everything via turbo:

```bash
pnpm dev
```

Other scripts (run with `pnpm --filter @peopleos/web <script>`):

- `build` — production build
- `start` — serve the production build
- `lint` — `next lint`
- `typecheck` — `tsc --noEmit`

> The API (`@peopleos/api`) must be running on `NEXT_PUBLIC_API_URL` for the Jobs
> pages to return data; otherwise they render a friendly error. The Rank button
> calls `POST /api/v1/applications/:id/rank`, which the API fulfils via the Python
> AI service (Module 1).

## Multi-tenancy & privacy notes

- The API is the tenant boundary. In production the org is resolved from the
  authenticated Clerk session server-side; the `X-Org-Id` header is **dev only**
  and is never sent when `NODE_ENV=production`.
- AI ranking tiers and scores are **advisory** (spec Module 1 ethics): the UI
  surfaces tier, score, sub-scores, summary, strengths, concerns, and interview
  focus to explain the ranking — but a recruiter always makes the advance/reject
  call. No screen acts on the score automatically.
- **Chain-of-thought reasoning is never displayed.** It is audit-only and
  persisted server-side; the wire contracts (`CandidateRanking`,
  `RankJobResponse`) have no reasoning field, so the client cannot show it even
  by accident. The UI shows only the returned explainability.
- **Attrition scoring is advisory + role-gated (Module 7).** The raw score and
  SHAP drivers are HR/ADMIN-only (the `/attrition` people-ops view); managers
  receive the redacted `ManagerAttritionView` (tier + recommendation ONLY — no
  score, no SHAP, no feature values), and the score is **never** shown to the
  employee. The API returns the role-appropriate shape and is the real boundary;
  the manager surface additionally down-renders any full shape to tier + actions
  so it can never leak a score. Employees can **opt out** of profiling entirely
  (`/settings`). The model uses only tenure / performance / team / skill signals,
  never a protected attribute, and a monthly **bias audit** checks
  tier-distribution disparity (the demographic mapping is supplied per-audit and
  never stored). No screen acts on a score automatically.

## Intentionally out of scope (skeleton)

No full pipeline Kanban, Zustand store, Socket.io streaming, or React Flow — those
come in later phases. The Module 5 analytics dashboard (Recharts) is built; its 5c
engagement section lights up with the **Module 7** attrition engine (now built) and
its 5d skills section with **Module 6**. Module 7's flight-risk roster and manager
view resolve specific employees by id (the contracts expose per-employee views +
an org `AttritionSummary`, not a paginated scored-employee list); push/digest
manager alerting (CRITICAL → 24h push, HIGH → weekly digest) is a server/worker
concern, not a web surface. Module 6 (Employee Skill Graph) is built and feeds the
5d skills section. The skill profile
is presented as a categorised badge list rather than the spec's circular force
graph (React Flow / D3 is a later phase); the confidence-sized `ConfidenceDot`
carries the "sized by proficiency confidence" intent. This package establishes the
typed, contract-faithful foundation.
