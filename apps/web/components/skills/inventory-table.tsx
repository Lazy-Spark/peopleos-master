import * as React from "react";

import { BuildVsBuyButton } from "@/components/skills/build-vs-buy-button";
import { CATEGORY_LABEL } from "@/components/skills/skill-display";
import { cn } from "@/lib/utils";
import type { SkillInventoryItem } from "@peopleos/schemas";

/**
 * InventoryTable — Module 6c org skill supply / demand / gap. Each row is a
 * `SkillInventoryItem`: `supply` (# employees holding it), `demand` (# open roles
 * requiring it), and the API-computed `gap` (demand − supply). Gapped skills
 * (gap > 0) are surfaced first and flagged red, and carry an inline AI
 * "Build vs buy" recommendation (`BuildVsBuyButton`). Surplus rows (gap < 0)
 * read green. Presentational only — every number is from the contract.
 */
export function InventoryTable({ items }: { items: SkillInventoryItem[] }) {
  // Largest gap first (most urgent), then by demand.
  const sorted = React.useMemo(
    () =>
      [...items].sort((a, b) => {
        const byGap = b.gap - a.gap;
        return byGap !== 0 ? byGap : b.demand - a.demand;
      }),
    [items],
  );

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No skills in the inventory yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Skill</th>
            <th className="px-3 py-2 font-medium">Category</th>
            <th className="px-3 py-2 text-right font-medium">Supply</th>
            <th className="px-3 py-2 text-right font-medium">Demand</th>
            <th className="px-3 py-2 text-right font-medium">Gap</th>
            <th className="px-3 py-2 font-medium">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((item) => {
            const gapped = item.gap > 0;
            const surplus = item.gap < 0;
            return (
              <tr key={item.skillId} className={cn(gapped && "bg-destructive/5")}>
                <td className="px-3 py-2 font-medium text-foreground">
                  {item.skillName}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {CATEGORY_LABEL[item.category]}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{item.supply}</td>
                <td className="px-3 py-2 text-right tabular-nums">{item.demand}</td>
                <td className="px-3 py-2 text-right">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                      gapped && "bg-destructive/10 text-destructive",
                      surplus && "bg-emerald-600/10 text-emerald-700",
                      !gapped && !surplus && "text-muted-foreground",
                    )}
                  >
                    {item.gap > 0 ? `+${item.gap}` : item.gap}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {gapped ? (
                    <BuildVsBuyButton skillId={item.skillId} />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
