import type { RankingTier, RiskTier } from "@peopleos/schemas";
import type { TxClient } from "../db.js";

/**
 * Module 7 — shared helpers for reading the LATEST attrition score per employee and
 * for aggregating tier distributions. Used by both routes/attrition.ts and the
 * Module 5 (5c) engagement/retention wiring in lib/analytics.ts, so the definition
 * of "current score" and the tier ordering stay identical across both surfaces.
 *
 * MULTI-TENANCY: every function takes the `tx` from `withTenant(orgId, …)`; RLS
 * scopes all reads to the caller's org.
 */

/** The risk tiers in severity order (worst first) — drives stable aggregation order. */
export const RISK_TIERS: readonly RiskTier[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

/** Default tiers that count as a "flagged" attrition outcome (spec: CRITICAL + HIGH). */
export const DEFAULT_SELECTION_TIERS: readonly RiskTier[] = ["CRITICAL", "HIGH"] as const;

/**
 * Map a RiskTier (CRITICAL/HIGH/MEDIUM/LOW) onto the disparity engine's RankingTier
 * (A/B/C/D), preserving severity order so the reused Module 1 disparity endpoint
 * (which is tier-agnostic statistics over A/B/C/D) treats CRITICAL/HIGH as the
 * top-of-funnel "selected" outcome by default. CRITICAL→A, HIGH→B, MEDIUM→C, LOW→D.
 */
export function riskTierToRankingTier(tier: RiskTier): RankingTier {
  switch (tier) {
    case "CRITICAL":
      return "A";
    case "HIGH":
      return "B";
    case "MEDIUM":
      return "C";
    case "LOW":
      return "D";
  }
}

/** The latest attrition score for one employee (the fields callers actually use). */
export interface LatestScore {
  employeeId: string;
  riskScore: number;
  riskTier: RiskTier;
  topDrivers: unknown;
  shapValues: unknown;
  scoredAt: Date;
}

/**
 * Load the LATEST AttritionScore per employee for the tenant (newest `scoredAt`
 * wins). The scorer UPSERTs one current row per employee, but we still de-dup by
 * newest so the read is correct even if multiple historical rows exist. Returns a
 * Map keyed by employeeId for O(1) joins.
 */
export async function loadLatestScores(tx: TxClient): Promise<Map<string, LatestScore>> {
  const rows = await tx.attritionScore.findMany({
    orderBy: { scoredAt: "desc" },
    select: {
      employeeId: true,
      riskScore: true,
      riskTier: true,
      topDrivers: true,
      shapValues: true,
      scoredAt: true,
    },
  });

  const latest = new Map<string, LatestScore>();
  for (const row of rows) {
    if (latest.has(row.employeeId)) continue; // newest-first → first seen is current
    latest.set(row.employeeId, {
      employeeId: row.employeeId,
      riskScore: row.riskScore,
      riskTier: row.riskTier as RiskTier,
      topDrivers: row.topDrivers,
      shapValues: row.shapValues,
      scoredAt: row.scoredAt,
    });
  }
  return latest;
}

/** Count scores per tier, in fixed severity order, with zero-fill for absent tiers. */
export function countByTier(scores: Iterable<{ riskTier: RiskTier }>): Array<{ tier: RiskTier; count: number }> {
  const counts = new Map<RiskTier, number>();
  for (const tier of RISK_TIERS) counts.set(tier, 0);
  for (const s of scores) counts.set(s.riskTier, (counts.get(s.riskTier) ?? 0) + 1);
  return RISK_TIERS.map((tier) => ({ tier, count: counts.get(tier) ?? 0 }));
}

/** A score is "regrettable" when a STRONG performer is at CRITICAL/HIGH risk. */
export const REGRETTABLE_MIN_RATING = 4;
export function isRegrettable(riskTier: RiskTier, perfRating: number | null): boolean {
  return (
    (riskTier === "CRITICAL" || riskTier === "HIGH") &&
    perfRating != null &&
    perfRating >= REGRETTABLE_MIN_RATING
  );
}
