import type { FastifyPluginAsync } from "fastify";
// Value import (not `import type`): we use `Prisma.DbNull` (a runtime sentinel) below,
// as well as the Prisma.*JsonValue types — a value import satisfies both.
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AnalyzeInterviewRequest,
  AnalyzeInterviewResponse,
  ApiError,
  CalibrationFlag,
  CompetencyDivergence,
  CreateInterviewRequest,
  InterviewScorecard,
  InterviewSummary,
  InterviewTranscript,
  PanelCalibration,
  ScorecardTemplate,
  SubmitScorecardRequest,
  SubmitTranscriptRequest,
  TranscribeRequest,
  type CalibrationFlag as TCalibrationFlag,
  type ScorecardTemplate as TScorecardTemplate,
} from "@peopleos/schemas";
import { withTenant, type TxClient } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { writeAudit } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { aiClient } from "../lib/aiClient.js";
import { buildOrgContext } from "../lib/orgContext.js";
import { transcriptStore } from "../lib/transcriptStore.js";
import { serializeInterview, serializeScorecard } from "../lib/serialize.js";

/**
 * Module 3 — Interview Intelligence & Summaries (mounted under /api/v1, tenant-scoped).
 *
 *   create     : POST   /api/v1/interviews                       (consent REQUIRED)
 *   submit txn : POST   /api/v1/interviews/:id/transcript        (store encrypted in S3)
 *   transcribe : POST   /api/v1/interviews/:id/transcribe        (WhisperX via AI service)
 *   analyze    : POST   /api/v1/interviews/:id/analyze           (4-step AI analysis)
 *   submit sc  : POST   /api/v1/scorecards/:id/submit            (reviewer's final scores)
 *   calibrate  : GET    /api/v1/applications/:id/calibration     (panel divergence + AI flags)
 *   DSAR delete: DELETE /api/v1/interviews/:id/transcript        (erase the transcript)
 *
 * PRIVACY (central to this module):
 *   - Candidate CONSENT is required before any recording/processing. Create enforces
 *     `consentObtained === true` (contract is `literal(true)`); transcript/transcribe
 *     re-check the stored consent flag (403 otherwise).
 *   - Transcripts are stored ONLY in S3, encrypted (SSE-KMS prod / AES-256 dev), NEVER
 *     in a plaintext DB column. The DB holds the object key + governance metadata.
 *   - Retention: on create we set `transcriptRetentionDeleteAt = now + org policy days`
 *     (default 90) so a retention job can purge expired transcripts.
 *   - DSAR: DELETE removes the S3 object and marks the interview transcript DELETED.
 *   - The raw transcript is NEVER returned to a client — only evidence quotes embedded
 *     inside the AI scorecard draft are surfaced.
 */

// ── Transcript lifecycle states (stored in Interview.transcriptStatus) ─────────
const TRANSCRIPT_STATUS = {
  PENDING: "PENDING",
  TRANSCRIBED: "TRANSCRIBED",
  ANALYZED: "ANALYZED",
  DELETED: "DELETED",
} as const;

/** Default transcript retention when the org has not configured a policy (spec: 90d). */
const DEFAULT_RETENTION_DAYS = 90;

/** Panel calibration flags divergence > 2 points on the same competency (spec step 4). */
const DIVERGENCE_THRESHOLD = 2;

/**
 * The built-in standard scorecard competency set used when an analyze request omits a
 * role-specific template. Generic, role-agnostic interview competencies so analysis is
 * always grounded in a defined rubric (spec step 2: "map competency areas to job
 * scorecard template configured per role").
 */
const STANDARD_COMPETENCIES: TScorecardTemplate = ScorecardTemplate.parse({
  competencies: [
    { competencyId: "problem_solving", name: "Problem Solving", description: "Analytical and structured problem solving." },
    { competencyId: "technical_skills", name: "Technical / Role Skills", description: "Depth of role-relevant expertise." },
    { competencyId: "communication", name: "Communication", description: "Clarity, structure, and listening." },
    { competencyId: "collaboration", name: "Collaboration & Teamwork", description: "Working with and influencing others." },
    { competencyId: "ownership", name: "Ownership & Impact", description: "Drive, accountability, and delivered results." },
  ],
});

/**
 * Read the org's configured transcript retention (days) from Organisation.settings,
 * falling back to the spec default (90). The settings column is free-form JSON; we
 * read only this one prompt-irrelevant governance field.
 */
const RetentionSettings = z
  .object({ transcriptRetentionDays: z.number().int().positive().optional() })
  .passthrough();

function retentionDays(settings: unknown): number {
  const parsed = RetentionSettings.safeParse(settings ?? {});
  return parsed.success && parsed.data.transcriptRetentionDays
    ? parsed.data.transcriptRetentionDays
    : DEFAULT_RETENTION_DAYS;
}

const InterviewIdParam = z.object({ id: z.string().uuid() });
const ScorecardIdParam = z.object({ id: z.string().uuid() });
const ApplicationIdParam = z.object({ id: z.string().uuid() });

/** transcribe body: the (private, org-infra) audio URL + the recording source. */
const TranscribeBody = z.object({
  audioUrl: z.string().url(),
  source: z.enum(["ZOOM", "GOOGLE_MEET", "MS_TEAMS", "UPLOAD"]),
  language: z.string().nullable().optional(),
});

/** analyze body: an optional role-specific scorecard template. Absent → standard set. */
const AnalyzeBody = z
  .object({ scorecardTemplate: ScorecardTemplate.optional() })
  .optional();

/**
 * Load an interview under the active tenant tx, throwing a clean 404 if it does not
 * exist in this org (RLS makes cross-tenant rows invisible).
 */
async function loadInterview(tx: TxClient, id: string) {
  const interview = await tx.interview.findUnique({ where: { id } });
  if (!interview) throw notFound(`Interview ${id} not found`);
  return interview;
}

const interviewRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Create an interview (consent REQUIRED) ───────────────────────────────────
  r.post(
    "/interviews",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Create an interview (Module 3). Candidate consent is required.",
        description:
          "Creates a SCHEDULED interview with transcriptStatus PENDING. consentObtained MUST be literal true (the contract enforces it; a non-true value is a 400). Sets transcriptRetentionDeleteAt = now + the org's retention policy (default 90 days). The application must belong to the caller's org. Audited.",
        body: CreateInterviewRequest,
        response: { 201: InterviewResponseSchema, 400: ApiError, 401: ApiError, 404: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, userId } = tenant(request);
      const body = request.body;

      // Defence-in-depth: the contract is `literal(true)`, so a false/missing value
      // already fails schema validation (400). We re-assert for an explicit message.
      if (body.consentObtained !== true) {
        throw badRequest("Candidate consent to record and process is required.");
      }

      const created = await withTenant(orgId, async (tx) => {
        // The application must exist in this org (RLS: cross-org id → not found).
        const application = await tx.application.findUnique({
          where: { id: body.applicationId },
          select: { id: true },
        });
        if (!application) throw notFound(`Application ${body.applicationId} not found`);

        const org = await tx.organisation.findUnique({
          where: { id: orgId },
          select: { settings: true },
        });
        const deleteAt = new Date(Date.now() + retentionDays(org?.settings) * 24 * 60 * 60 * 1000);

        const interview = await tx.interview.create({
          data: {
            orgId,
            applicationId: body.applicationId,
            interviewerIds: body.interviewerIds,
            scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
            durationMinutes: body.durationMinutes ?? null,
            type: body.type,
            status: "SCHEDULED",
            consentObtained: true,
            transcriptStatus: TRANSCRIPT_STATUS.PENDING,
            transcriptRetentionDeleteAt: deleteAt,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "interview.create",
          entityType: "interview",
          entityId: interview.id,
          payload: {
            applicationId: body.applicationId,
            type: body.type,
            consentObtained: true,
            retentionDeleteAt: deleteAt.toISOString(),
          },
          ip: request.ip,
        });
        return interview;
      });

      return reply.code(201).send(serializeInterview(created));
    },
  );

  // ── Submit a transcript (already diarised) → encrypt + store in S3 ────────────
  r.post(
    "/interviews/:id/transcript",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Submit an interview transcript (stored encrypted in S3).",
        description:
          "Requires the interview's stored consent flag (403 if consent was not obtained). Validates the transcript against the InterviewTranscript contract, stores it ENCRYPTED in S3 (never a plaintext DB column), and sets transcriptPath + transcriptStatus=TRANSCRIBED. The transcript is never echoed back. Audited.",
        params: InterviewIdParam,
        body: SubmitTranscriptRequest,
        response: { 200: InterviewResponseSchema, 400: ApiError, 401: ApiError, 403: ApiError, 404: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId } = tenant(request);
      const { id } = request.params;
      const { transcript } = request.body;

      // Phase 1: authorise (consent gate) inside the tenant tx.
      await withTenant(orgId, async (tx) => {
        const interview = await loadInterview(tx, id);
        if (!interview.consentObtained) {
          throw forbidden("Candidate consent was not obtained; cannot store a transcript.");
        }
      });

      // Phase 2: encrypt + store the transcript in S3 (outside the DB tx — object
      // storage is not transactional). Validated against the contract by the store.
      const key = await transcriptStore.put(orgId, id, InterviewTranscript.parse(transcript));

      // Phase 3: record the object key + status; never the transcript body itself.
      const updated = await withTenant(orgId, async (tx) => {
        const row = await tx.interview.update({
          where: { id },
          data: {
            transcriptPath: key,
            transcriptStatus: TRANSCRIPT_STATUS.TRANSCRIBED,
            // A re-submission after a DSAR delete clears the deletion timestamp.
            transcriptDeletedAt: null,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "interview.transcript.submit",
          entityType: "interview",
          entityId: id,
          payload: {
            source: transcript.source,
            segments: transcript.segments.length,
            diarised: transcript.diarised,
          },
          ip: request.ip,
        });
        return row;
      });

      return serializeInterview(updated);
    },
  );

  // ── Transcribe from audio via the AI service (self-hosted WhisperX) ───────────
  r.post(
    "/interviews/:id/transcribe",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Transcribe interview audio (self-hosted WhisperX) and store it.",
        description:
          "Requires the interview's stored consent flag (403 otherwise). Calls the AI service's self-hosted WhisperX endpoint (large-v3 + diarisation; NOT a hosted ASR, for data privacy), then stores the result ENCRYPTED in S3 and sets transcriptPath + transcriptStatus=TRANSCRIBED. The GPU worker is auto-scaled, so a transient 503 is expected and surfaces as a clean 502. Audited.",
        params: InterviewIdParam,
        body: TranscribeBody,
        response: { 200: InterviewResponseSchema, 400: ApiError, 401: ApiError, 403: ApiError, 404: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId } = tenant(request);
      const { id } = request.params;
      const { audioUrl, source, language } = request.body;

      // Consent gate first.
      await withTenant(orgId, async (tx) => {
        const interview = await loadInterview(tx, id);
        if (!interview.consentObtained) {
          throw forbidden("Candidate consent was not obtained; cannot transcribe audio.");
        }
      });

      // Call the AI service (WhisperX). A 503 (GPU worker cold) → clean 502 AiServiceError.
      // .parse() brands orgId/interviewId to the contract's OrgId/InterviewId types.
      const result = await aiClient.transcribeInterview(
        TranscribeRequest.parse({
          orgId,
          interviewId: id,
          audioUrl,
          source,
          language: language ?? null,
        }),
      );

      // Store the diarised transcript encrypted in S3.
      const key = await transcriptStore.put(orgId, id, result.transcript);

      const updated = await withTenant(orgId, async (tx) => {
        const row = await tx.interview.update({
          where: { id },
          data: {
            transcriptPath: key,
            transcriptStatus: TRANSCRIPT_STATUS.TRANSCRIBED,
            transcriptDeletedAt: null,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "interview.transcribe",
          entityType: "interview",
          entityId: id,
          payload: {
            source,
            modelVersion: result.modelVersion,
            durationSec: result.transcript.durationSec,
            segments: result.transcript.segments.length,
          },
          ip: request.ip,
        });
        return row;
      });

      return serializeInterview(updated);
    },
  );

  // ── Analyze a stored transcript (the 4 AI steps) ──────────────────────────────
  r.post(
    "/interviews/:id/analyze",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Analyse an interview transcript (Module 3 — the 4 AI steps).",
        description:
          "Requires a stored transcript (404 if the transcript was deleted/never stored, 409 if the interview was never transcribed). Loads the transcript from S3, builds the AnalyzeInterviewRequest (orgContext from the org, jobTitle from the application's job, scorecardTemplate from the body or a built-in standard set), and calls the AI service. UPSERTs the AI Scorecard row (reviewerId null) writing ai_summary + ai_scorecard_draft, sets transcriptStatus=ANALYZED. The raw transcript is NEVER returned — only evidence quotes inside the draft. Audited.",
        params: InterviewIdParam,
        body: AnalyzeBody,
        response: { 200: AnalyzeInterviewResponse, 400: ApiError, 401: ApiError, 403: ApiError, 404: ApiError, 409: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id } = request.params;
      const template = request.body?.scorecardTemplate ?? STANDARD_COMPETENCIES;

      // Phase 1: load interview + org + job context; require a stored transcript.
      const ctx = await withTenant(orgId, async (tx) => {
        const interview = await loadInterview(tx, id);
        // Consent can be revoked after transcription; re-check before analysing (cheap
        // defence-in-depth on top of the submit/transcribe gates).
        if (!interview.consentObtained) {
          throw forbidden("Candidate consent was not obtained; cannot analyse this transcript.");
        }
        if (interview.transcriptStatus === TRANSCRIPT_STATUS.DELETED) {
          throw notFound("The transcript for this interview has been deleted.");
        }
        if (!interview.transcriptPath) {
          throw conflict("This interview has no stored transcript yet; transcribe it first.");
        }
        const application = await tx.application.findUnique({
          where: { id: interview.applicationId },
          select: { jobId: true },
        });
        const job = application
          ? await tx.jobOpening.findUnique({
              where: { id: application.jobId },
              select: { title: true },
            })
          : null;
        const org = await tx.organisation.findUnique({
          where: { id: orgId },
          select: { name: true, settings: true },
        });
        return { interview, jobTitle: job?.title ?? null, org };
      });

      // Phase 2: load the transcript from S3 (encrypted at rest). A missing object
      // (e.g. raced with a DSAR delete) → 404.
      const transcript = await transcriptStore.get(orgId, id);
      if (!transcript) {
        throw notFound("The transcript for this interview is not available.");
      }

      // Phase 3: call the AI service. Request + response are Zod-validated by aiClient.
      const req = AnalyzeInterviewRequest.parse({
        orgId,
        interviewId: id,
        jobTitle: ctx.jobTitle,
        scorecardTemplate: template,
        transcript,
        orgContext: buildOrgContext(ctx.org, role),
      });
      const result = await aiClient.analyzeInterview(req);

      // Phase 4: UPSERT the AI scorecard row (the AI draft, reviewerId null). We store
      // the draft PLUS competencyEvidence + calibrationFlags in the ai_scorecard_draft
      // JSON blob (the draft contract proper has no flags field); the serializer splits
      // them back out on read. ai_summary mirrors draft.summary for quick display.
      await withTenant(orgId, async (tx) => {
        const draftBlob = {
          ...result.scorecardDraft,
          competencyEvidence: result.competencyEvidence,
          calibrationFlags: result.calibrationFlags,
        } as unknown as Prisma.InputJsonValue;

        // One AI draft per interview (reviewerId null). Find-then-write keeps it
        // idempotent across re-analysis without relying on a composite unique key.
        const existing = await tx.scorecard.findFirst({
          where: { interviewId: id, reviewerId: null },
          select: { id: true },
        });
        if (existing) {
          await tx.scorecard.update({
            where: { id: existing.id },
            data: {
              applicationId: ctx.interview.applicationId,
              aiSummary: result.scorecardDraft.summary,
              aiScorecardDraft: draftBlob,
            },
          });
        } else {
          await tx.scorecard.create({
            data: {
              orgId,
              interviewId: id,
              applicationId: ctx.interview.applicationId,
              reviewerId: null,
              aiSummary: result.scorecardDraft.summary,
              aiScorecardDraft: draftBlob,
            },
          });
        }

        await tx.interview.update({
          where: { id },
          data: { transcriptStatus: TRANSCRIPT_STATUS.ANALYZED },
        });

        await writeAudit(tx, {
          actorId: userId,
          action: "interview.analyze",
          entityType: "interview",
          entityId: id,
          // Decision record only — no transcript text, no evidence quotes in the audit.
          payload: {
            modelVersion: result.modelVersion,
            promptVersion: result.promptVersion,
            overallRecommendation: result.scorecardDraft.overallRecommendation,
            confidence: result.scorecardDraft.confidence,
            competencyCount: result.scorecardDraft.competencyScores.length,
            calibrationFlagCount: result.calibrationFlags.length,
            biasIndicatorsDetected: result.scorecardDraft.biasCheck.biasIndicatorsDetected.length,
          },
          ip: request.ip,
        });
      });

      // Return the validated AI response (evidence quotes live INSIDE the draft; the
      // raw transcript never leaves the API).
      return result;
    },
  );

  // ── Get an interview's governance view (no transcript) ───────────────────────
  r.get(
    "/interviews/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Get an interview's governance view (consent + transcript status).",
        description:
          "Returns the privacy-safe InterviewSummary (consent, transcript status/retention, hasTranscript) — never the transcript itself. 404 if the interview is not in the caller's org.",
        params: InterviewIdParam,
        response: { 200: InterviewSummary, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;
      return withTenant(orgId, async (tx) => serializeInterview(await loadInterview(tx, id)));
    },
  );

  // ── Get an interview's scorecard (AI draft + any reviewer scores) ─────────────
  r.get(
    "/interviews/:id/scorecard",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Get the interview's scorecard (AI draft + reviewer scores).",
        description:
          "Returns the InterviewScorecard for this interview (the AI draft row, reviewerId null). Evidence quotes embedded in the draft are the ONLY transcript-derived text surfaced — the raw transcript is never returned. 404 if the interview has not been analysed yet (or its derived data was erased via DSAR).",
        params: InterviewIdParam,
        response: { 200: InterviewScorecard, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;
      return withTenant(orgId, async (tx) => {
        await loadInterview(tx, id); // 404 if cross-org / missing (RLS-scoped)
        const scorecard = await tx.scorecard.findFirst({
          where: { interviewId: id, reviewerId: null },
        });
        if (!scorecard) throw notFound("This interview has not been analysed yet.");
        return serializeScorecard(scorecard);
      });
    },
  );

  // ── Submit a reviewer's final (human) scorecard ───────────────────────────────
  r.post(
    "/scorecards/:id/submit",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Submit a reviewer's final scorecard (Module 3).",
        description:
          "Sets the reviewer's competency_scores, overall recommendation, and submittedAt on an existing scorecard. The scorecard must belong to the caller's org. Audited. Returns the persisted InterviewScorecard.",
        params: ScorecardIdParam,
        body: SubmitScorecardRequest,
        response: { 200: InterviewScorecard, 400: ApiError, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId } = tenant(request);
      const { id } = request.params;
      const { competencyScores, overallRecommendation } = request.body;

      const updated = await withTenant(orgId, async (tx) => {
        const existing = await tx.scorecard.findUnique({ where: { id } });
        if (!existing) throw notFound(`Scorecard ${id} not found`);

        // Normalise to the stored shape: { competencyId, score, evidence|null }.
        const scores = competencyScores.map((s) => ({
          competencyId: s.competencyId,
          score: s.score,
          evidence: s.evidence ?? null,
        }));

        const row = await tx.scorecard.update({
          where: { id },
          data: {
            // The submitting user is the reviewer of record for this final scorecard.
            reviewerId: userId,
            competencyScores: scores as unknown as Prisma.InputJsonValue,
            overall: overallRecommendation,
            submittedAt: new Date(),
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "scorecard.submit",
          entityType: "scorecard",
          entityId: id,
          payload: {
            overallRecommendation,
            competencyCount: scores.length,
            interviewId: existing.interviewId,
            applicationId: existing.applicationId,
          },
          ip: request.ip,
        });
        return row;
      });

      return serializeScorecard(updated);
    },
  );

  // ── Panel calibration for an application (API-computed divergence + AI flags) ──
  r.get(
    "/applications/:id/calibration",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Panel calibration for an application (Module 3 — step 4).",
        description:
          "Loads ALL submitted scorecards for the application, computes per-competency score divergence (flags a spread > 2 points — the NUMERIC divergence is computed HERE, not by the AI service), and gathers the stored AI calibration flags (leading/illegal questions) from the application's interviews' ai_scorecard_draft. Returns a PanelCalibration.",
        params: ApplicationIdParam,
        response: { 200: PanelCalibration, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;

      const result = await withTenant(orgId, async (tx) => {
        const application = await tx.application.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!application) throw notFound(`Application ${id} not found`);

        // All SUBMITTED reviewer scorecards (human scores drive the divergence).
        const submitted = await tx.scorecard.findMany({
          where: { applicationId: id, submittedAt: { not: null } },
          select: { reviewerId: true, competencyScores: true },
        });

        // All AI drafts for this application's interviews carry per-interview flags.
        const drafts = await tx.scorecard.findMany({
          where: { applicationId: id, aiScorecardDraft: { not: Prisma.DbNull } },
          select: { aiScorecardDraft: true },
        });

        return computeCalibration(id, submitted, drafts);
      });

      return result;
    },
  );

  // ── DSAR: delete an interview transcript (idempotent) ─────────────────────────
  r.delete(
    "/interviews/:id/transcript",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["interviews"],
        summary: "Delete an interview transcript (DSAR / right to erasure).",
        description:
          "Deletes the encrypted transcript object from S3, nulls transcriptPath, and sets transcriptStatus=DELETED + transcriptDeletedAt. Idempotent: deleting an already-deleted or never-stored transcript succeeds. Audited.",
        params: InterviewIdParam,
        response: { 200: InterviewResponseSchema, 401: ApiError, 404: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId } = tenant(request);
      const { id } = request.params;

      // Confirm the interview exists in this org (404 otherwise).
      await withTenant(orgId, async (tx) => {
        await loadInterview(tx, id);
      });

      // Delete the S3 object first (idempotent: a missing object is a no-op). Doing
      // this before the DB write means we never mark DELETED while the object lingers.
      await transcriptStore.delete(orgId, id);

      const updated = await withTenant(orgId, async (tx) => {
        const row = await tx.interview.update({
          where: { id },
          data: {
            transcriptPath: null,
            transcriptStatus: TRANSCRIPT_STATUS.DELETED,
            transcriptDeletedAt: new Date(),
          },
        });
        // Right-to-erasure must also remove transcript-DERIVED text: the AI scorecard
        // draft embeds verbatim transcript quotes (every evidenceQuote) and the summary.
        // Null them so no excerpt of the "deleted" transcript survives anywhere in the DB.
        await tx.scorecard.updateMany({
          where: { interviewId: id },
          data: { aiScorecardDraft: Prisma.DbNull, aiSummary: null },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "interview.transcript.delete",
          entityType: "interview",
          entityId: id,
          payload: { reason: "dsar", deletedAt: row.transcriptDeletedAt?.toISOString() ?? null },
          ip: request.ip,
        });
        return row;
      });

      return serializeInterview(updated);
    },
  );
};

/**
 * The privacy-safe Interview governance view (now a shared contract in
 * @peopleos/schemas so the web client validates the exact same shape). It never
 * includes the transcript itself, only governance metadata + a `hasTranscript` flag.
 */
const InterviewResponseSchema = InterviewSummary;

/**
 * Compute panel calibration: per-competency numeric divergence across submitted
 * reviewer scorecards (flag spread > threshold) + the gathered per-interview AI flags
 * (leading/illegal questions). The numeric divergence is computed HERE (not by the AI
 * service) — the AI only supplies the qualitative leading/illegal-question flags.
 */
function computeCalibration(
  applicationId: string,
  submitted: Array<{ reviewerId: string | null; competencyScores: Prisma.JsonValue }>,
  drafts: Array<{ aiScorecardDraft: Prisma.JsonValue | null }>,
): z.infer<typeof PanelCalibration> {
  const ScoresShape = z
    .array(z.object({ competencyId: z.string(), score: z.number().int() }).passthrough())
    .catch([]);

  // Group reviewer scores by competencyId.
  const byCompetency = new Map<
    string,
    Array<{ reviewerId: string | null; score: number }>
  >();
  for (const sc of submitted) {
    const scores = ScoresShape.parse(sc.competencyScores);
    for (const cs of scores) {
      const list = byCompetency.get(cs.competencyId) ?? [];
      list.push({ reviewerId: sc.reviewerId, score: cs.score });
      byCompetency.set(cs.competencyId, list);
    }
  }

  const divergences: z.infer<typeof CompetencyDivergence>[] = [];
  for (const [competencyId, list] of byCompetency) {
    // Divergence is only meaningful with at least two reviewers on the competency.
    if (list.length < 2) continue;
    const scores = list.map((x) => x.score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const spread = maxScore - minScore;
    if (spread > DIVERGENCE_THRESHOLD) {
      divergences.push(
        CompetencyDivergence.parse({
          competencyId,
          minScore,
          maxScore,
          spread,
          reviewerScores: list.map((x) => ({ reviewerId: x.reviewerId, score: x.score })),
        }),
      );
    }
  }

  // Gather the per-interview AI flags from each draft blob (the draft proper has none).
  const FlagEnvelope = z
    .object({ calibrationFlags: z.array(CalibrationFlag).catch([]) })
    .partial()
    .passthrough();
  const aiFlags: TCalibrationFlag[] = [];
  for (const d of drafts) {
    if (d.aiScorecardDraft == null) continue;
    const parsed = FlagEnvelope.safeParse(d.aiScorecardDraft);
    if (parsed.success && parsed.data.calibrationFlags) {
      aiFlags.push(...parsed.data.calibrationFlags);
    }
  }

  return PanelCalibration.parse({
    applicationId,
    reviewerCount: submitted.length,
    divergences,
    aiFlags,
  });
}

export default interviewRoutes;
