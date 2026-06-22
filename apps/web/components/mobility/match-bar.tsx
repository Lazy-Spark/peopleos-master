import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * MatchBar — the skill-coverage match score for a (employee, role) or
 * (employee, gig) pair, rendered as a labelled percentage bar.
 *
 * `value` is the frozen `matchScore` — a unit score in [0, 1] equal to the skill
 * coverage computed server-side from the Module 6 skill graph (matched required
 * skills / all required skills). Purely presentational: the bar never derives the
 * score, it only visualises it. Colour ramps red → emerald with coverage so a
 * strong match reads green at a glance.
 */
function matchColor(pct: number): string {
  if (pct >= 90) return "bg-emerald-500";
  if (pct >= 70) return "bg-green-500";
  if (pct >= 50) return "bg-blue-500";
  if (pct >= 30) return "bg-amber-500";
  return "bg-destructive";
}

export function MatchBar({
  /** Unit score in [0, 1] — the frozen `matchScore` (skill coverage). */
  value,
  label = "Match",
  className,
}: {
  value: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.min(1, Math.max(0, value));
  const pct = Math.round(clamped * 100);

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{pct}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${label} ${pct}%`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-all", matchColor(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
