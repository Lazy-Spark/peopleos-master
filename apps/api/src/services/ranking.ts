import type { Prisma } from "@prisma/client";
import {
  ApplicationAiRanking,
  CandidateProfile,
  JDStructured,
  OrgContext,
  RankJobResponse,
  ScoreBatchRequest,
  ScoreCandidateRequest,
  type ApplicationAiRanking as TApplicationAiRanking,
  type CandidateRanking as TCandidateRanking,
  type OrgContext as TOrgContext,
  type RankJobResponse as TRankJobResponse,
  type RankSkip as TRankSkip,
  type ApplicationStage as TApplicationStage,
} from "@peopleos/schemas";
import { z } from "zod";
import { withTenant, type TxClient } from "../db.js";
import { aiClient, AiServiceError } from "../lib/aiClient.js";
import { writeAudit } from "../lib/audit.js";

/**
 * Shared Module 1 (AI Resume Screening & Candidate Ranking) ranking service.
 *
 * This module owns the persistence + audit semantics for rankings so the three
 * callers — the single-rank HTTP route, the batch job-pipeline route, and the
 * BullMQ auto-trigger worker — all behave identically:
 *
 *   - The AI service scores the STRUCTURED CandidateProfile (never the raw resume)
 *     and masks name/school/grad-year before its holistic LLM step (standard #4).
 *   - The returned CandidateRanking is CoT-free; the chain-of-thought `reasoning`
 *     is persisted ONLY to candidate_rankings.reasoning (audit-only, standard #3).
 *   - Every write goes through withTenant() so RLS scopes it to the org, and every
 *     .create sets orgId so the RLS WITH CHECK predicate is satisfied.
 *   - Every scoring decision is recorded in the AuditLog (no CoT in the payload).
 *
 * The external AI HTTP call (up to 30s) is made OUTSIDE the DB transaction so it
 * never holds a connection open; the persistence transaction re-checks existence.
 */

/** Prompt-relevant slice of Organisation.settings (free-form JSON column). */
const OrgPromptSettings = z
  .object({
    industry: z.string().nullable().optional(),
    headcount: z.number().int().nullable().optional(),
    tonePreferences: z.string().nullable().optional(),
    customRules: z.array(z.string()).optional(),
  })
  .passthrough();

/** Default stages whose applications are screened by the job pipeline. */
const DEFAULT_PIPELINE_STAGES: TApplicationStage[] = ["SCREENING"];

/** Options shared across the ranking entry points. */
export interface RankOptions {
  /** The user attributed in the audit log + (via role) in the prompt context. */
  actorId?: string | null;
  /** The reviewing user's role — fed to the AI as orgContext.userRole (standard #1). */
  userRole?: TOrgContext["userRole"];
  /** Caller IP for the audit entry (HTTP routes pass request.ip; the worker omits). */
  ip?: string | null;
}

/** Discriminated result of ranking a single application. */
export type RankApplicationResult =
  | { status: "ranked"; ranking: TCandidateRanking }
  | { status: "skipped"; candidateId: string; reason: string };

const NO_PROFILE_REASON =
  "Candidate has no parsed profile yet; run the resume pipeline before ranking.";

/**
 * Build the per-org prompt context (standard #1) from the Organisation row + the
 * reviewing user's role. Absent fields → generic prompt framing in the AI service.
 */
function buildOrgContext(
  org: { name: string | null; settings: unknown } | null,
  userRole: TOrgContext["userRole"],
): TOrgContext {
  const parsed = OrgPromptSettings.safeParse(org?.settings ?? {});
  const s = parsed.success ? parsed.data : {};
  return OrgContext.parse({
    orgName: org?.name ?? null,
    userRole: userRole ?? null,
    industry: s.industry ?? null,
    headcount: s.headcount ?? null,
    tonePreferences: s.tonePreferences ?? null,
    customRules: s.customRules ?? [],
  });
}

/** Build the compact ApplicationAiRanking embedded on the Application row. */
function compactSummary(ranking: TCandidateRanking): TApplicationAiRanking {
  return ApplicationAiRanking.parse({
    score: ranking.finalScore,
    tier: ranking.tier,
    strengths: ranking.strengths,
    concerns: ranking.concerns,
    interviewFocus: ranking.interviewFocus,
    summary: ranking.aiSummary,
    modelVersion: ranking.modelVersion,
    scoredAt: ranking.scoredAt,
  });
}

/**
 * Insert a candidate_rankings row, including the audit-only `reasoning` column.
 * `tx` is the tenant transaction so orgId satisfies the RLS WITH CHECK predicate.
 */
async function persistRanking(
  tx: TxClient,
  orgId: string,
  ranking: TCandidateRanking,
  reasoning: string | null,
): Promise<void> {
  await tx.candidateRanking.create({
    data: {
      orgId,
      candidateId: ranking.candidateId,
      jobId: ranking.jobId,
      finalScore: ranking.finalScore,
      tier: ranking.tier,
      skillMatchPct: ranking.skillMatchPct,
      expRelevance: ranking.expRelevanceScore,
      components: ranking.components as unknown as Prisma.InputJsonValue,
      strengths: ranking.strengths,
      concerns: ranking.concerns,
      interviewFocus: ranking.interviewFocus,
      aiSummary: ranking.aiSummary,
      biasCheck: ranking.biasCheck as unknown as Prisma.InputJsonValue,
      confidence: ranking.confidence,
      // Audit-only chain-of-thought. NEVER returned to clients.
      reasoning,
      modelVersion: ranking.modelVersion,
      promptVersion: ranking.promptVersion ?? null,
      scoredAt: new Date(ranking.scoredAt),
    },
  });
}

/**
 * Update Application.aiRanking + write the scoring audit entry, inside `tx`.
 * The audit payload is the compact, non-CoT decision summary; reasoning lives ONLY
 * in candidate_rankings.reasoning (standard #3).
 */
async function recordRankingOnApplication(
  tx: TxClient,
  applicationId: string,
  ranking: TCandidateRanking,
  opts: RankOptions,
): Promise<void> {
  await tx.application.update({
    where: { id: applicationId },
    data: { aiRanking: compactSummary(ranking) as unknown as Prisma.InputJsonValue },
  });
  await writeAudit(tx, {
    actorId: opts.actorId ?? null,
    action: "application.rank",
    entityType: "application",
    entityId: applicationId,
    payload: {
      candidateId: ranking.candidateId,
      jobId: ranking.jobId,
      finalScore: ranking.finalScore,
      tier: ranking.tier,
      modelVersion: ranking.modelVersion,
    },
    ip: opts.ip ?? null,
  });
}

/**
 * Rank a single application (Module 1 full pipeline). Returns a discriminated
 * result: `skipped` when the candidate has no parsed profile (the ranker scores
 * the structured profile, not the raw file), `ranked` otherwise.
 *
 * Shape mirrors the single-rank route's three phases:
 *   1. load app + candidate + job + org via withTenant (RLS scopes to the org);
 *   2. call the AI service OUTSIDE any transaction;
 *   3. persist ranking (+ reasoning) + update Application.aiRanking + audit, atomic.
 */
export async function rankApplication(
  orgId: string,
  applicationId: string,
  opts: RankOptions = {},
): Promise<RankApplicationResult> {
  // ── Phase 1: load everything inside the tenant transaction ──────────────────
  const loaded = await withTenant(orgId, async (tx) => {
    const application = await tx.application.findUnique({ where: { id: applicationId } });
    if (!application) return null;

    const [candidate, job, org] = await Promise.all([
      tx.candidate.findUnique({ where: { id: application.candidateId } }),
      tx.jobOpening.findUnique({ where: { id: application.jobId } }),
      tx.organisation.findUnique({ where: { id: orgId } }),
    ]);
    // Under RLS these only resolve if they belong to the caller's org.
    if (!candidate || !job) return null;
    return { application, candidate, job, org };
  });

  if (!loaded) {
    throw new RankingNotFoundError(`Application ${applicationId} not found`);
  }

  // RLS already guarantees this (a foreign application is invisible), but assert the
  // (possibly queue-supplied) orgId actually owns the loaded application — defence in depth.
  if (loaded.application.orgId !== orgId) {
    throw new RankingNotFoundError(`Application ${applicationId} not found`);
  }

  // No structured profile → cannot score. Surface a skip the caller can map.
  if (loaded.candidate.profile == null) {
    return { status: "skipped", candidateId: loaded.candidate.id, reason: NO_PROFILE_REASON };
  }

  const profile = CandidateProfile.parse(loaded.candidate.profile);
  const jdStructured =
    loaded.job.jdStructured == null ? null : JDStructured.parse(loaded.job.jdStructured);
  const orgContext = buildOrgContext(loaded.org, opts.userRole);

  const scoreRequest = ScoreCandidateRequest.parse({
    orgId,
    jobId: loaded.job.id,
    candidateId: loaded.candidate.id,
    profile,
    jdText: loaded.job.jdText,
    jdStructured,
    orgContext,
    // weights omitted → AI service applies org defaults (0.35/0.30/0.25/0.10).
  });

  // ── Phase 2: call the AI service (validated request + response) ─────────────
  const { ranking, reasoning } = await aiClient.scoreWithReasoning(scoreRequest);

  // Never trust AI-returned ids to address our DB rows: the service must echo back
  // the exact candidate/job we sent. A mismatch could persist a ranking under our
  // org that FK-points at another tenant's candidate (RLS WITH CHECK validates only
  // org_id, not the candidate/job FK).
  if (ranking.candidateId !== loaded.candidate.id || ranking.jobId !== loaded.job.id) {
    throw new AiServiceError(
      "AI service returned a ranking for a different candidate/job than requested",
      502,
      {
        expected: { candidateId: loaded.candidate.id, jobId: loaded.job.id },
        got: { candidateId: ranking.candidateId, jobId: ranking.jobId },
      },
    );
  }

  // ── Phase 3: persist ranking + application summary + audit (atomic) ─────────
  await withTenant(orgId, async (tx) => {
    // Defensive against a concurrent delete between the two transactions.
    const stillThere = await tx.application.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!stillThere) throw new RankingNotFoundError(`Application ${applicationId} not found`);

    await persistRanking(tx, orgId, ranking, reasoning);
    await recordRankingOnApplication(tx, applicationId, ranking, opts);
  });

  return { status: "ranked", ranking };
}

/**
 * Rank a whole job pipeline (POST /api/v1/jobs/:id/rank). Loads the job + org +
 * the job's applications in the requested stages (default [SCREENING]) whose
 * candidate has a parsed profile, builds ONE ScoreBatchRequest with org context,
 * fans out to the AI batch endpoint, persists every ranking (+ per-item reasoning)
 * and updates each Application.aiRanking + audit — all inside a single tenant
 * transaction — and returns the RankJobResponse with rankings sorted best-first
 * (CoT-free) plus any skipped candidates.
 */
export async function rankJobPipeline(
  orgId: string,
  jobId: string,
  opts: RankOptions & { stages?: TApplicationStage[] } = {},
): Promise<TRankJobResponse> {
  const stages =
    opts.stages && opts.stages.length > 0 ? opts.stages : DEFAULT_PIPELINE_STAGES;

  // ── Phase 1: load job + org + applications (with candidates) ────────────────
  const loaded = await withTenant(orgId, async (tx) => {
    const job = await tx.jobOpening.findUnique({ where: { id: jobId } });
    if (!job) return null;

    const org = await tx.organisation.findUnique({ where: { id: orgId } });
    const applications = await tx.application.findMany({
      where: { jobId, stage: { in: stages } },
      orderBy: { appliedAt: "desc" },
      include: { candidate: true },
    });
    return { job, org, applications };
  });

  if (!loaded) {
    throw new RankingNotFoundError(`Job ${jobId} not found`);
  }

  // Partition: candidates with a parsed profile are scorable; the rest are skipped.
  const scorable: Array<{ applicationId: string; candidateId: string; profile: unknown }> = [];
  const skipped: TRankSkip[] = [];
  for (const app of loaded.applications) {
    if (app.candidate.profile == null) {
      skipped.push({
        candidateId: app.candidate.id,
        reason: NO_PROFILE_REASON,
      });
    } else {
      scorable.push({
        applicationId: app.id,
        candidateId: app.candidate.id,
        profile: app.candidate.profile,
      });
    }
  }

  const scoredAt = new Date().toISOString();

  // Nothing to score → return early (still a valid, sorted-empty response).
  if (scorable.length === 0) {
    return RankJobResponse.parse({ jobId, rankings: [], skipped, scoredAt });
  }

  const jdStructured =
    loaded.job.jdStructured == null ? null : JDStructured.parse(loaded.job.jdStructured);
  const orgContext = buildOrgContext(loaded.org, opts.userRole);

  // ── Phase 2: build ONE batch request and fan out via the AI service ─────────
  const batchRequest = ScoreBatchRequest.parse({
    orgId,
    jobId,
    jdText: loaded.job.jdText,
    jdStructured,
    orgContext,
    candidates: scorable.map((c) => ({
      candidateId: c.candidateId,
      profile: CandidateProfile.parse(c.profile),
    })),
    // weights omitted → AI service applies org defaults.
  });

  const { rankings, reasonings } = await aiClient.scoreBatch(batchRequest);

  // Map candidateId → applicationId; `submitted` guards against the AI service
  // echoing back an id we never sent — a foreign candidateId would otherwise create
  // a candidate_rankings row under our org that FK-points at another tenant's
  // candidate (RLS WITH CHECK validates only org_id, not the candidate/job FK).
  const applicationByCandidate = new Map(scorable.map((c) => [c.candidateId, c.applicationId]));
  const submitted = new Set(scorable.map((c) => c.candidateId));

  // Keep only rankings for a candidate we actually submitted for THIS job; never
  // trust AI-returned ids to address our DB rows.
  const valid: Array<{ ranking: TCandidateRanking; reasoning: string | null }> = [];
  for (let i = 0; i < rankings.length; i++) {
    const ranking = rankings[i];
    if (!ranking) continue;
    if (ranking.jobId !== jobId || !submitted.has(ranking.candidateId)) continue;
    valid.push({ ranking, reasoning: reasonings[i] ?? null });
  }
  const rankedIds = new Set(valid.map((v) => v.ranking.candidateId));

  // ── Phase 3: persist every valid ranking (+ reasoning) + update apps + audit ─
  await withTenant(orgId, async (tx) => {
    for (const { ranking, reasoning } of valid) {
      await persistRanking(tx, orgId, ranking, reasoning);
      const applicationId = applicationByCandidate.get(ranking.candidateId);
      if (applicationId) {
        await recordRankingOnApplication(tx, applicationId, ranking, opts);
      }
    }
  });

  // A scorable candidate with no valid ranking (AI-side failure or an out-of-batch
  // echo) must not silently vanish from the shortlist — surface it as a skip.
  for (const c of scorable) {
    if (!rankedIds.has(c.candidateId)) {
      skipped.push({
        candidateId: c.candidateId,
        reason: "Scoring failed during batch ranking; re-run this candidate individually.",
      });
    }
  }

  // ── Sort best-first (finalScore desc) and return CoT-free ───────────────────
  const sorted = valid.map((v) => v.ranking).sort((a, b) => b.finalScore - a.finalScore);
  return RankJobResponse.parse({ jobId, rankings: sorted, skipped, scoredAt });
}

/**
 * Raised by the service when a required entity (application / job) is not visible
 * under the tenant's RLS context. The HTTP routes map this to a 404; the worker
 * logs it (a deleted application is not a retryable failure).
 */
export class RankingNotFoundError extends Error {
  readonly code = "RANKING_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "RankingNotFoundError";
  }
}
