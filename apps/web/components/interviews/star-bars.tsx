import * as React from "react";

import { ScoreBar } from "@/components/ui/score-bar";
import { cn } from "@/lib/utils";
import type { StarScores } from "@peopleos/schemas";

/**
 * StarBars — renders STAR completeness for one answer (Module 3 analyze step 1:
 * "STAR = Situation, Task, Action, Result — score each dimension"). Each
 * dimension is a unit score in [0, 1]; we reuse the shared `ScoreBar`. An
 * optional overall `starCompleteness` is shown as a compact header figure.
 *
 * Typed off the frozen `StarScores` contract — no local shapes. Purely
 * presentational: this is explainability for the reviewer, not a decision.
 */

const STAR_DIMENSIONS: ReadonlyArray<{ key: keyof StarScores; label: string }> = [
  { key: "situation", label: "Situation" },
  { key: "task", label: "Task" },
  { key: "action", label: "Action" },
  { key: "result", label: "Result" },
];

export function StarBars({
  star,
  /** Overall STAR completeness for the answer, [0, 1] (CompetencyEvidence). */
  completeness,
  className,
}: {
  star: StarScores;
  completeness?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          STAR completeness
        </p>
        {typeof completeness === "number" ? (
          <span className="text-xs font-medium tabular-nums">
            {Math.round(Math.min(1, Math.max(0, completeness)) * 100)}%
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {STAR_DIMENSIONS.map(({ key, label }) => (
          <ScoreBar key={key} label={label} value={star[key]} />
        ))}
      </div>
    </div>
  );
}
