"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  RiskTierBadge,
  TIER_SEVERITY,
} from "@/components/attrition/risk-tier-badge";
import type { AttritionEmployeeView, RiskTier } from "@peopleos/schemas";

/**
 * FlightRiskList — the HR/leadership flight-risk roster: the employees at
 * CRITICAL / HIGH attrition risk, most urgent first, each a drill-down into
 * their drivers + narrative + recommended actions.
 *
 * Typed off the FULL `AttritionEmployeeView` (HR/ADMIN view) — but it renders
 * ONLY the tier here (via `RiskTierBadge`), not the raw score, keeping the list
 * itself scannable. The full score + SHAP drivers live in the drill-down panel,
 * which is HR-only by contract. This list is never shown to managers (their view
 * is tier + recommendation per direct report) nor to the employee.
 */

/** Tiers that count as "flight risk" (spec manager-alerting: CRITICAL + HIGH). */
const FLIGHT_RISK_TIERS: ReadonlySet<RiskTier> = new Set<RiskTier>([
  "CRITICAL",
  "HIGH",
]);

export function FlightRiskList({
  employees,
  selectedId,
  onSelect,
  className,
}: {
  employees: ReadonlyArray<AttritionEmployeeView>;
  selectedId?: string | null;
  onSelect?: (employeeId: string) => void;
  className?: string;
}) {
  const flightRisk = React.useMemo(
    () =>
      [...employees]
        .filter((e) => FLIGHT_RISK_TIERS.has(e.riskTier))
        .sort((a, b) => {
          const bySeverity =
            TIER_SEVERITY[a.riskTier] - TIER_SEVERITY[b.riskTier];
          // Within a tier, highest raw score first (HR-only ordering signal).
          return bySeverity !== 0 ? bySeverity : b.riskScore - a.riskScore;
        }),
    [employees],
  );

  if (flightRisk.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No employees are at CRITICAL or HIGH attrition risk in this set.
      </p>
    );
  }

  return (
    <ul className={cn("divide-y rounded-lg border", className)}>
      {flightRisk.map((e) => {
        const active = e.employeeId === selectedId;
        return (
          <li key={e.employeeId}>
            <button
              type="button"
              onClick={() => onSelect?.(e.employeeId)}
              aria-pressed={active}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                active && "bg-accent/60",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {e.employeeName ?? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {e.employeeId.slice(0, 8)}…
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Scored {new Date(e.scoredAt).toLocaleDateString()}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <RiskTierBadge tier={e.riskTier} />
                <span aria-hidden className="text-muted-foreground">
                  ›
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export { FLIGHT_RISK_TIERS };
