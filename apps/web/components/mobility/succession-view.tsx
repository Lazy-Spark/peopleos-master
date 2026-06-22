import * as React from "react";

import { cn } from "@/lib/utils";
import { MatchBar } from "@/components/mobility/match-bar";
import { ReadinessBadge } from "@/components/mobility/readiness-badge";
import { RiskTierBadge } from "@/components/attrition/risk-tier-badge";
import { KpiTile } from "@/components/analytics/kpi-tile";
import type { SuccessionCandidate, SuccessionPlan } from "@peopleos/schemas";

/**
 * SuccessionView — the succession plan for a senior / critical role (8d).
 *
 * Headlines the `benchStrength` and the `readyNow` / `readySoon` counts, then
 * groups the `successors` into three bands: Ready now, Ready soon, and the wider
 * Bench (STRETCH). GOVERNANCE: each successor's `flightRisk` (Module 7 attrition
 * TIER, never the raw score) is shown ONLY when the API supplies it (non-null ⇒
 * ADMIN / HRBP viewer). A role with no successors is surfaced explicitly — that
 * is the "talent pipeline health" signal (which roles have no internal bench).
 */
export function SuccessionView({
  plan,
  className,
}: {
  plan: SuccessionPlan;
  className?: string;
}) {
  const readyNow = plan.successors.filter((s) => s.readiness === "READY_NOW");
  const readySoon = plan.successors.filter((s) => s.readiness === "READY_SOON");
  const bench = plan.successors.filter((s) => s.readiness === "STRETCH");

  return (
    <div className={cn("space-y-6", className)}>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Bench strength"
          value={String(plan.benchStrength)}
          hint="Internal candidates with meaningful coverage"
          tone={plan.benchStrength === 0 ? "alert" : "default"}
        />
        <KpiTile
          label="Ready now"
          value={String(plan.readyNow)}
          hint="Could step into the role today"
          tone={plan.readyNow > 0 ? "good" : "default"}
        />
        <KpiTile
          label="Ready soon"
          value={String(plan.readySoon)}
          hint="A short development plan away"
        />
      </div>

      {plan.successors.length === 0 ? (
        <p className="rounded-lg border border-amber-600/40 bg-amber-600/10 p-4 text-sm text-amber-700">
          No internal successors for <span className="font-medium">{plan.roleTitle}</span>.
          This role is a talent-pipeline gap — consider building a bench or
          planning an external hire.
        </p>
      ) : (
        <div className="space-y-5">
          <SuccessionBand title="Ready now" candidates={readyNow} />
          <SuccessionBand title="Ready soon" candidates={readySoon} />
          <SuccessionBand title="Bench (stretch)" candidates={bench} />
        </div>
      )}
    </div>
  );
}

function SuccessionBand({
  title,
  candidates,
}: {
  title: string;
  candidates: readonly SuccessionCandidate[];
}) {
  if (candidates.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">
        {title} <span className="tabular-nums">({candidates.length})</span>
      </h3>
      <ul className="space-y-2">
        {candidates.map((s) => (
          <li
            key={s.employeeId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {s.employeeName ?? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {s.employeeId.slice(0, 8)}…
                    </span>
                  )}
                </span>
                <ReadinessBadge readiness={s.readiness} />
                {/* GOVERNANCE: tier-only, ADMIN / HRBP-only (null ⇒ hidden). */}
                {s.flightRisk ? <RiskTierBadge tier={s.flightRisk} /> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {s.level ?? "—"} · {s.gapSize} skill{s.gapSize === 1 ? "" : "s"} to
                close
              </p>
            </div>
            <div className="w-40 shrink-0">
              <MatchBar value={s.matchScore} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
