import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * KpiTile — a single headline metric (Module 5a/5b KPI tiles: time-to-fill,
 * time-to-hire, offer-acceptance rate, total headcount, …).
 *
 * Purely presentational. The caller formats the value (and unit) from the
 * API-computed `DashboardMetrics`; this component never derives numbers. A null
 * metric (e.g. `timeToFillDays` when no roles have been filled) should be passed
 * as a "—" value so the tile reads as "not yet available" rather than "0".
 */
export function KpiTile({
  label,
  value,
  unit,
  hint,
  /** Optional accent for an at-a-glance state (e.g. "alert" for SLA pressure). */
  tone = "default",
  className,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "default" | "alert" | "good";
  className?: string;
}) {
  const toneClass =
    tone === "alert"
      ? "text-destructive"
      : tone === "good"
        ? "text-green-700"
        : "text-foreground";

  return (
    <div className={cn("rounded-lg border bg-card p-4", className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 flex items-baseline gap-1", toneClass)}>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {unit ? (
          <span className="text-sm font-normal text-muted-foreground">{unit}</span>
        ) : null}
      </p>
      {hint ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
