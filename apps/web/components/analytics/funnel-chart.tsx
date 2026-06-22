"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import type { FunnelStage, StageConversion } from "@peopleos/schemas";

/**
 * FunnelChart — the recruiting funnel (Module 5a): candidates by pipeline stage
 * (applied → screened → interviewed → offered → hired) with stage-to-stage
 * conversion rates.
 *
 * Rendered as a CSS bar funnel (each stage's bar width is proportional to the
 * funnel's widest stage) rather than Recharts, because a stage funnel reads
 * better as labelled ranked bars with the inline conversion arrow between them.
 * All counts/rates come from the API-computed `RecruitingFunnel`; nothing is
 * derived here beyond the bar width and the percentage display.
 */

/** Human labels for the frozen `ApplicationStage` enum (in funnel order). */
const STAGE_LABEL: Record<FunnelStage["stage"], string> = {
  APPLIED: "Applied",
  SCREENING: "Screening",
  INTERVIEW: "Interview",
  OFFER: "Offer",
  HIRED: "Hired",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};

/** Display order — the active funnel stages first, terminal states last. */
const STAGE_ORDER: FunnelStage["stage"][] = [
  "APPLIED",
  "SCREENING",
  "INTERVIEW",
  "OFFER",
  "HIRED",
  "REJECTED",
  "WITHDRAWN",
];

export function FunnelChart({
  byStage,
  conversionRates,
  className,
}: {
  byStage: FunnelStage[];
  conversionRates: StageConversion[];
  className?: string;
}) {
  const ordered = [...byStage].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
  );
  const max = Math.max(1, ...ordered.map((s) => s.count));

  // Index conversions by their `from` stage so we can show the arrow beneath it.
  const conversionFrom = new Map<string, StageConversion>();
  for (const c of conversionRates) conversionFrom.set(c.from, c);

  if (ordered.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No pipeline data yet.</p>
    );
  }

  return (
    <div className={cn("space-y-1", className)}>
      {ordered.map((stage) => {
        const pct = Math.round((stage.count / max) * 100);
        const conv = conversionFrom.get(stage.stage);
        const isTerminal = stage.stage === "REJECTED" || stage.stage === "WITHDRAWN";
        return (
          <div key={stage.stage}>
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {STAGE_LABEL[stage.stage]}
              </span>
              <div className="relative h-7 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className={cn(
                    "flex h-full items-center rounded px-2 transition-all",
                    isTerminal ? "bg-muted-foreground/30" : "bg-primary/80",
                  )}
                  style={{ width: `${Math.max(pct, 6)}%` }}
                >
                  <span className="text-xs font-medium tabular-nums text-primary-foreground mix-blend-luminosity">
                    {stage.count.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
            {conv ? (
              <div className="ml-24 pl-3 text-[11px] text-muted-foreground">
                ↳ {Math.round(conv.rate * 100)}% to {STAGE_LABEL[conv.to]}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
