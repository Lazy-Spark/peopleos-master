import { z } from "zod";
import { CandidateProfile } from "./candidate.js";
import { CandidateId, JobId, OrgId, UnitScore, UserRole } from "./common.js";
import { JDStructured } from "./job.js";
import { CandidateRanking } from "./ranking.js";

/**
 * Contract between the Fastify API and the Python AI service (services/ai).
 * These shapes MUST match the Pydantic models in services/ai/app/schemas.py.
 * The AI service emits camelCase JSON to honour the shared convention.
 */

// ── Resume parse (spec Layer 2A) ─────────────────────────────────────────────
export const ParseResumeRequest = z
  .object({
    orgId: OrgId,
    candidateId: CandidateId,
    /** Exactly one of fileUrl / rawText must be provided. */
    fileUrl: z.string().url().optional(), // S3/MinIO presigned URL
    rawText: z.string().optional(),
    mimeType: z
      .enum(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"])
      .optional(),
  })
  .refine((v) => Boolean(v.fileUrl) !== Boolean(v.rawText), {
    message: "Provide exactly one of fileUrl or rawText",
  });
export type ParseResumeRequest = z.infer<typeof ParseResumeRequest>;

export const ParseResumeResponse = z.object({
  profile: CandidateProfile,
  warnings: z.array(z.string()).default([]),
  modelVersion: z.string(),
  parsedAt: z.string().datetime({ offset: true }),
});
export type ParseResumeResponse = z.infer<typeof ParseResumeResponse>;

// ── JD parse (Module 1 step 1) ───────────────────────────────────────────────
export const ParseJobDescriptionRequest = z.object({
  orgId: OrgId,
  jobId: JobId,
  jdText: z.string().min(1),
});
export type ParseJobDescriptionRequest = z.infer<typeof ParseJobDescriptionRequest>;

export const ParseJobDescriptionResponse = z.object({
  jdStructured: JDStructured,
  modelVersion: z.string(),
});
export type ParseJobDescriptionResponse = z.infer<typeof ParseJobDescriptionResponse>;

// ── Candidate ranking (Module 1, full pipeline) ──────────────────────────────
/** Per-org configurable weights (spec: stored in OrgSettings). Must sum to ~1. */
export const RankingWeights = z
  .object({
    skillMatch: UnitScore.default(0.35),
    expRelevance: UnitScore.default(0.3),
    holistic: UnitScore.default(0.25),
    yoeMatch: UnitScore.default(0.1),
  })
  .refine((w) => Math.abs(w.skillMatch + w.expRelevance + w.holistic + w.yoeMatch - 1) < 0.001, {
    message: "Ranking weights must sum to 1.0",
  });
export type RankingWeights = z.infer<typeof RankingWeights>;

/**
 * Optional per-org context passed to the AI so prompts can personalise per
 * prompt-engineering standard #1 (org name/industry/size, the reviewing user's
 * role, tone + custom rules). All fields optional; absent → generic prompt framing.
 * Mirrored as OrgContext in services/ai/app/schemas.py.
 */
export const OrgContext = z.object({
  orgName: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  headcount: z.number().int().nullable().optional(),
  userRole: UserRole.nullable().optional(),
  tonePreferences: z.string().nullable().optional(),
  customRules: z.array(z.string()).default([]),
});
export type OrgContext = z.infer<typeof OrgContext>;

export const ScoreCandidateRequest = z.object({
  orgId: OrgId,
  jobId: JobId,
  candidateId: CandidateId,
  profile: CandidateProfile,
  jdText: z.string().nullable(),
  jdStructured: JDStructured.nullable(),
  weights: RankingWeights.optional(),
  orgContext: OrgContext.optional(),
});
export type ScoreCandidateRequest = z.infer<typeof ScoreCandidateRequest>;

/** The AI service returns a full CandidateRanking (Module 1 output schema). */
export const ScoreCandidateResponse = CandidateRanking;
export type ScoreCandidateResponse = z.infer<typeof ScoreCandidateResponse>;

// ── Batch ranking (Module 1: parallelised across an applicant batch) ─────────
/** One candidate's pre-loaded structured profile for batch scoring. */
export const BatchCandidateInput = z.object({
  candidateId: CandidateId,
  profile: CandidateProfile,
});
export type BatchCandidateInput = z.infer<typeof BatchCandidateInput>;

/**
 * Score many candidates against one job in a single call. The AI service fans out
 * internally (bounded concurrency) to hold the <8s/candidate latency target.
 */
export const ScoreBatchRequest = z.object({
  orgId: OrgId,
  jobId: JobId,
  jdText: z.string().nullable(),
  jdStructured: JDStructured.nullable(),
  weights: RankingWeights.optional(),
  orgContext: OrgContext.optional(),
  candidates: z.array(BatchCandidateInput).min(1).max(200),
});
export type ScoreBatchRequest = z.infer<typeof ScoreBatchRequest>;

/**
 * Batch result. Each ranking is a full CandidateRanking (CoT-free); over the
 * internal boundary the AI service additionally emits a sibling `reasoning` per
 * item, which the non-strict schema strips and the API reads from the raw body.
 */
export const ScoreBatchResponse = z.object({
  rankings: z.array(CandidateRanking),
});
export type ScoreBatchResponse = z.infer<typeof ScoreBatchResponse>;

// ── AI service health ────────────────────────────────────────────────────────
export const AiHealth = z.object({
  status: z.literal("ok"),
  model: z.string(),
  version: z.string(),
});
export type AiHealth = z.infer<typeof AiHealth>;
