import * as React from "react";

import { cn } from "@/lib/utils";
import type { DriverContribution } from "@peopleos/schemas";

/**
 * DriverList — the SHAP-style top drivers behind an attrition score (spec Module
 * 7: "which features drove the score"). HR / ADMIN ONLY — this surfaces feature
 * labels and signed contributions, which managers must NEVER see (the manager
 * view carries no drivers at all). Each driver is shown with its direction
 * (INCREASES / DECREASES risk) and a magnitude bar from |contribution|.
 *
 * Purely presentational: the contributions come from the AI scorer via the
 * `AttritionEmployeeView` contract; this component only formats and lays them out.
 */
export function DriverList({
  drivers,
  className,
}: {
  drivers: ReadonlyArray<DriverContribution>;
  className?: string;
}) {
  if (drivers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No individual drivers were surfaced for this score.
      </p>
    );
  }

  // Normalise magnitudes to the largest contribution so the bars are comparable.
  const maxAbs = Math.max(...drivers.map((d) => Math.abs(d.contribution)), 1e-9);

  return (
    <ul className={cn("space-y-2", className)}>
      {drivers.map((d) => {
        const increases = d.direction === "INCREASES";
        const pct = Math.round((Math.abs(d.contribution) / maxAbs) * 100);
        return (
          <li key={d.feature} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">{d.label}</span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
                  increases
                    ? "bg-destructive/10 text-destructive"
                    : "bg-emerald-600/10 text-emerald-700",
                )}
                title={`Contribution ${d.contribution.toFixed(3)}`}
              >
                <span aria-hidden>{increases ? "↑" : "↓"}</span>
                {increases ? "Increases" : "Decreases"} risk
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label={`${d.label} contribution magnitude`}
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  increases ? "bg-destructive" : "bg-emerald-600",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
