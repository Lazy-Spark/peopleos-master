import { z } from "zod";
import {
  CandidateId,
  Confidence,
  IsoDateTime,
  JobId,
  Percent,
  RankingTier,
  UnitScore,
} from "./common.js";

/**
 * Bias-check envelope attached to every HR-facing LLM output (prompt standard #4).
 */
export const BiasCheck = z.object({
  biasIndicatorsDetected: z.array(z.string()).default([]),
  correctionApplied: z.boolean().default(false),
});
export type BiasCheck = z.infer<typeof BiasCheck>;

/**
 * HolisticAssessment — the LLM's structured output from Module 1 step 4.
 * The model receives a BIAS-MASKED profile (no name/gender/grad-year/school).
 * Chain-of-thought is required and stored server-side for audit, never returned.
 */
export const HolisticAssessment = z.object({
  holisticScore: UnitScore,
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  suggestedInterviewFocus: z.array(z.string()),
  calibrationNote: z.string(),
  confidence: Confidence,
  biasCheck: BiasCheck,
});
export type HolisticAssessment = z.infer<typeof HolisticAssessment>;

/** Component sub-scores that compose the final ranking (Module 1 step 5). */
export const RankingComponents = z.object({
  skillMatch: UnitScore, // weight 0.35
  expRelevance: UnitScore, // weight 0.30
  holisticScore: UnitScore, // weight 0.25
  yoeMatch: UnitScore, // weight 0.10
});
export type RankingComponents = z.infer<typeof RankingComponents>;

/**
 * CandidateRanking — the persisted, API-returned ranking record (Module 1 output).
 */
export const CandidateRanking = z.object({
  candidateId: CandidateId,
  jobId: JobId,
  finalScore: UnitScore,
  tier: RankingTier,
  skillMatchPct: Percent,
  expRelevanceScore: UnitScore,
  components: RankingComponents,
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  interviewFocus: z.array(z.string()),
  aiSummary: z.string(),
  biasCheck: BiasCheck,
  confidence: Confidence,
  scoredAt: IsoDateTime,
  modelVersion: z.string(),
  /** PromptVersion id used for this scoring (versioning standard #6). */
  promptVersion: z.string().nullable(),
});
export type CandidateRanking = z.infer<typeof CandidateRanking>;

/** A candidate skipped during batch ranking (e.g. no parsed profile yet). */
export const RankSkip = z.object({
  candidateId: CandidateId,
  reason: z.string(),
});
export type RankSkip = z.infer<typeof RankSkip>;

/**
 * Result of screening a whole job pipeline (POST /api/v1/jobs/:id/rank): rankings
 * sorted best-first (CoT-free), plus any candidates that were skipped (e.g. no
 * parsed profile). Mirrors what the recruiter shortlist UI renders.
 */
export const RankJobResponse = z.object({
  jobId: JobId,
  rankings: z.array(CandidateRanking),
  skipped: z.array(RankSkip),
  scoredAt: IsoDateTime,
});
export type RankJobResponse = z.infer<typeof RankJobResponse>;
