import * as React from "react";

import { cn } from "@/lib/utils";
import type { RiskTier } from "@peopleos/schemas";

/**
 * RiskTierBadge — the Module 7 attrition risk tier pill (CRITICAL → LOW).
 *
 * Severity runs red (CRITICAL) → green (LOW). The tier is ADVISORY ONLY (spec
 * ethics: "no automated HR actions based on score alone") and is the ONLY risk
 * signal a manager ever sees — never the raw score, the SHAP values, or the
 * feature values. The score is also NEVER shown to the employee. This component
 * deliberately renders only the tier label so it is safe to use in every view.
 */
const TIER_CLASS: Record<RiskTier, string> = {
  CRITICAL: "border-destructive/40 bg-destructive/10 text-destructive",
  HIGH: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  MEDIUM: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  LOW: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
};

const TIER_LABEL: Record<RiskTier, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

export function RiskTierBadge({
  tier,
  className,
}: {
  tier: RiskTier;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TIER_CLASS[tier],
        className,
      )}
      aria-label={`${TIER_LABEL[tier]} attrition risk (advisory)`}
      title="Attrition risk tier (advisory — never shown to the employee)"
    >
      {TIER_LABEL[tier]} risk
    </span>
  );
}

/** Tier ordering for sorting flight-risk lists (most urgent first). */
export const TIER_SEVERITY: Record<RiskTier, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export { TIER_LABEL };
