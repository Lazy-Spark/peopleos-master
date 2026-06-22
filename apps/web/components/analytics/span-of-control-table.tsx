import * as React from "react";

import { cn } from "@/lib/utils";
import type { SpanFlag, SpanOfControl } from "@peopleos/schemas";

/**
 * SpanOfControlTable — managers with their direct-report count, flagging
 * outliers (Module 5b): WIDE (>8 reports → manager overload) and NARROW
 * (<3 reports → possible org-design issue). The flag is API-computed on the
 * frozen `SpanOfControl.flag`; this component only colours and labels it.
 *
 * Flagged rows are surfaced first (WIDE, then NARROW, then OK) so the reviewer
 * sees the actionable spans at the top.
 */

const FLAG_LABEL: Record<SpanFlag, string> = {
  WIDE: "Wide",
  NARROW: "Narrow",
  OK: "OK",
};

const FLAG_PILL: Record<SpanFlag, string> = {
  WIDE: "border-destructive/40 bg-destructive/10 text-destructive",
  NARROW: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  OK: "border-input bg-muted text-muted-foreground",
};

const FLAG_RANK: Record<SpanFlag, number> = { WIDE: 0, NARROW: 1, OK: 2 };

export function SpanOfControlTable({
  rows,
  className,
}: {
  rows: SpanOfControl[];
  className?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No manager data yet.</p>
    );
  }

  const sorted = [...rows].sort((a, b) => {
    const byFlag = FLAG_RANK[a.flag] - FLAG_RANK[b.flag];
    return byFlag !== 0 ? byFlag : b.directReports - a.directReports;
  });

  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Manager</th>
            <th className="px-3 py-2 text-right font-medium">Direct reports</th>
            <th className="px-3 py-2 text-right font-medium">Span</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((row) => (
            <tr key={row.managerId}>
              <td className="px-3 py-2">
                {row.managerName ?? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {row.managerId.slice(0, 8)}…
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {row.directReports}
              </td>
              <td className="px-3 py-2 text-right">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                    FLAG_PILL[row.flag],
                  )}
                >
                  {FLAG_LABEL[row.flag]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
