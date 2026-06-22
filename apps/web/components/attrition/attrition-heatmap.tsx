"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { TIER_LABEL } from "@/components/attrition/risk-tier-badge";
import type { AttritionHeatCell, RiskTier } from "@peopleos/schemas";

/**
 * AttritionHeatmap — the Module 7 risk heatmap: groups (rows) × risk tiers
 * (columns), each cell the headcount in that group at that tier, shaded by tier
 * severity (CRITICAL red → LOW green) with intensity scaled by the count.
 *
 * The heatmap aggregates `AttritionHeatCell[]` from the `AttritionSummary`
 * contract across three dimensions (DEPARTMENT / LEVEL / TEAM); the caller picks
 * which dimension to show. This is an aggregate, advisory view — it shows only
 * tier COUNTS, never an individual's raw score. Presentational only.
 */

type Dimension = AttritionHeatCell["dimension"];

const TIER_ORDER: RiskTier[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/** Base colour per tier; opacity is driven by the relative count below. */
const TIER_BASE: Record<RiskTier, { rgb: string; text: string }> = {
  CRITICAL: { rgb: "239 68 68", text: "text-destructive" }, // red-500
  HIGH: { rgb: "217 119 6", text: "text-amber-700" }, // amber-600
  MEDIUM: { rgb: "37 99 235", text: "text-blue-700" }, // blue-600
  LOW: { rgb: "5 150 105", text: "text-emerald-700" }, // emerald-600
};

const DIMENSION_LABEL: Record<Dimension, string> = {
  DEPARTMENT: "Department",
  LEVEL: "Level",
  TEAM: "Team",
};

export function AttritionHeatmap({
  cells,
  dimension,
  className,
}: {
  cells: ReadonlyArray<AttritionHeatCell>;
  dimension: Dimension;
  className?: string;
}) {
  const scoped = React.useMemo(
    () => cells.filter((c) => c.dimension === dimension),
    [cells, dimension],
  );

  // group → tier → count
  const byGroup = React.useMemo(() => {
    const m = new Map<string, Map<RiskTier, number>>();
    for (const c of scoped) {
      const row = m.get(c.group) ?? new Map<RiskTier, number>();
      row.set(c.tier, (row.get(c.tier) ?? 0) + c.count);
      m.set(c.group, row);
    }
    return m;
  }, [scoped]);

  // Largest single cell count → opacity scale (so the worst cell reads solid).
  const maxCount = React.useMemo(
    () => Math.max(1, ...scoped.map((c) => c.count)),
    [scoped],
  );

  // Order groups by total risk-weighted headcount (most at-risk first).
  const groups = React.useMemo(() => {
    const weight = (g: string) => {
      const row = byGroup.get(g);
      if (!row) return 0;
      // CRITICAL weighted 4× down to LOW 1× — a simple severity-weighted total.
      return (
        (row.get("CRITICAL") ?? 0) * 4 +
        (row.get("HIGH") ?? 0) * 3 +
        (row.get("MEDIUM") ?? 0) * 2 +
        (row.get("LOW") ?? 0) * 1
      );
    };
    return [...byGroup.keys()].sort((a, b) => weight(b) - weight(a));
  }, [byGroup]);

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No {DIMENSION_LABEL[dimension].toLowerCase()} risk data yet — run scoring
        to populate the heatmap.
      </p>
    );
  }

  return (
    <div className={cn("overflow-x-auto rounded-lg border", className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-muted/40">
            <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {DIMENSION_LABEL[dimension]}
            </th>
            {TIER_ORDER.map((tier) => (
              <th
                key={tier}
                className={cn(
                  "px-2 py-2 text-center text-xs font-medium",
                  TIER_BASE[tier].text,
                )}
              >
                {TIER_LABEL[tier]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {groups.map((group) => {
            const row = byGroup.get(group);
            return (
              <tr key={group}>
                <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
                  {group}
                </td>
                {TIER_ORDER.map((tier) => {
                  const count = row?.get(tier) ?? 0;
                  if (count === 0) {
                    return (
                      <td
                        key={tier}
                        className="px-2 py-2 text-center text-muted-foreground/30"
                        aria-label={`${group} ${TIER_LABEL[tier]}: 0`}
                      >
                        ·
                      </td>
                    );
                  }
                  // Opacity floor so even a single person reads legibly.
                  const intensity = 0.18 + (count / maxCount) * 0.82;
                  const solid = intensity > 0.6;
                  return (
                    <td key={tier} className="px-1.5 py-1.5 text-center">
                      <span
                        className={cn(
                          "inline-flex h-7 min-w-[2.5rem] items-center justify-center rounded text-[11px] font-semibold tabular-nums",
                          solid ? "text-white" : "text-foreground",
                        )}
                        style={{
                          backgroundColor: `rgb(${TIER_BASE[tier].rgb} / ${intensity})`,
                        }}
                        title={`${count} at ${TIER_LABEL[tier]} risk in ${group}`}
                        aria-label={`${group} ${TIER_LABEL[tier]}: ${count}`}
                      >
                        {count}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export { DIMENSION_LABEL };
export type { Dimension as HeatmapDimension };
