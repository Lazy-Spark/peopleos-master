import * as React from "react";

import { cn } from "@/lib/utils";
import type { RankingTier } from "@peopleos/schemas";

/**
 * TierBadge — the AI ranking tier pill (spec Module 1 output: A best → D weakest).
 *
 * Colour cue runs green (A) → red (D). The tier is ADVISORY ONLY (spec Module 1
 * ethics: "no automated HR actions based on score alone"); a recruiter always
 * makes the call. The raw composite score is shown separately, never the
 * chain-of-thought reasoning (that is audit-only and the API never returns it).
 */
const TIER_CLASS: Record<RankingTier, string> = {
  A: "border-green-600/40 bg-green-600/10 text-green-700",
  B: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  C: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  D: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function TierBadge({
  tier,
  className,
}: {
  tier: RankingTier;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TIER_CLASS[tier],
        className,
      )}
      aria-label={`AI ranking tier ${tier} (advisory)`}
      title="AI ranking tier (advisory)"
    >
      Tier {tier}
    </span>
  );
}
