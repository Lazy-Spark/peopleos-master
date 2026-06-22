import { z } from "zod";
import { CandidateId, IsoDateTime, JobId, RankingTier, UnitScore } from "./common.js";

/**
 * Bias / adverse-impact disparity monitoring for Module 1 (spec step 6 + the
 * ethics checklist). PeopleOS deliberately does NOT store protected attributes,
 * so a demographic mapping is supplied per-request by the org (only where EEOC
 * self-id data legitimately exists). The AI service computes selection-rate
 * parity (the EEOC "4/5ths rule") and score distribution — no LLM is involved.
 */

// ── AI service contract (services/ai computes the statistics) ────────────────
/** One scored candidate tagged with a provided demographic group label. */
export const DisparityRecord = z.object({
  group: z.string().min(1),
  score: UnitScore,
  tier: RankingTier,
});
export type DisparityRecord = z.infer<typeof DisparityRecord>;

export const DisparityRequest = z.object({
  records: z.array(DisparityRecord).min(1),
  /** Tiers counted as a positive selection outcome (default: A and B). */
  selectionTiers: z.array(RankingTier).default(["A", "B"]),
});
export type DisparityRequest = z.infer<typeof DisparityRequest>;

export const GroupStat = z.object({
  group: z.string(),
  n: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  selectionRate: UnitScore,
  meanScore: UnitScore,
});
export type GroupStat = z.infer<typeof GroupStat>;

export const DisparityReport = z.object({
  groups: z.array(GroupStat),
  /** Group with the highest selection rate — the 4/5ths comparison reference. */
  referenceGroup: z.string().nullable(),
  /** min(selectionRate) / max(selectionRate); null when undefined. */
  adverseImpactRatio: z.number().min(0).nullable(),
  /** True when adverseImpactRatio < 0.8 (the EEOC 4/5ths threshold). */
  fourFifthsViolation: z.boolean(),
  /** True when the selection-rate spread exceeds 10 percentage points (spec). */
  disproportionateFlag: z.boolean(),
  generatedAt: IsoDateTime,
});
export type DisparityReport = z.infer<typeof DisparityReport>;

// ── API-facing (the API joins rankings with a provided demographic mapping) ──
export const JobBiasAuditRequest = z.object({
  /** candidateId → demographic group label (provided by the org; never stored). */
  demographics: z
    .array(z.object({ candidateId: CandidateId, group: z.string().min(1) }))
    .min(1),
  selectionTiers: z.array(RankingTier).optional(),
});
export type JobBiasAuditRequest = z.infer<typeof JobBiasAuditRequest>;

export const JobBiasAuditResponse = z.object({
  jobId: JobId,
  report: DisparityReport,
  /** Candidates in the mapping that had no ranking yet (excluded from the report). */
  unmatched: z.array(CandidateId),
});
export type JobBiasAuditResponse = z.infer<typeof JobBiasAuditResponse>;
