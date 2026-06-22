import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * ScoreBar — a small labelled progress bar for a single ranking sub-score.
 *
 * Sub-scores from `RankingComponents` are unit scores in [0, 1]; pass them
 * through unchanged and the bar renders them as a percentage. Purely
 * presentational — explainability for the recruiter (spec Module 1 step 5),
 * not a decision.
 */
export function ScoreBar({
  label,
  /** Unit score in [0, 1] (e.g. RankingComponents.skillMatch). */
  value,
  /** Optional weight badge, e.g. "×0.35", to show how the component composes. */
  weight,
  className,
}: {
  label: string;
  value: number;
  weight?: string;
  className?: string;
}) {
  const clamped = Math.min(1, Math.max(0, value));
  const pct = Math.round(clamped * 100);

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {label}
          {weight ? (
            <span className="ml-1 text-[10px] text-muted-foreground/70">{weight}</span>
          ) : null}
        </span>
        <span className="font-medium tabular-nums">{pct}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
