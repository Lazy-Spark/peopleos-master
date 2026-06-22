"use client";

import { useQueries } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  RiskTierBadge,
  TIER_SEVERITY,
} from "@/components/attrition/risk-tier-badge";
import { api, isFullAttritionView } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ManagerAttritionView } from "@peopleos/schemas";

/**
 * ManagerAttritionTeam (Module 7, manager client).
 *
 * The manager enters their direct reports' employee IDs; for each we read
 * `api.getEmployeeAttrition`, which (for a MANAGER role) returns the redacted
 * `ManagerAttritionView` — the risk TIER + recommended talking points ONLY.
 *
 * This component deliberately renders NO numeric score, NO SHAP, and NO feature
 * values — it has no access to them (the manager shape carries none) and the UI
 * shows nothing beyond the tier and the recommendations. If a privileged caller
 * happened to receive the full HR shape, we down-render it to tier + actions so
 * this surface stays redacted regardless.
 */
export function ManagerAttritionTeam() {
  const [raw, setRaw] = React.useState("");
  const [ids, setIds] = React.useState<string[]>([]);

  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["attrition", "employee", id] as const,
      queryFn: () => api.getEmployeeAttrition(id),
    })),
  });

  // Down-render anything (even a full HR shape) to the redacted tier + actions.
  const reports = React.useMemo<ManagerAttritionView[]>(() => {
    const out: ManagerAttritionView[] = [];
    for (const r of results) {
      if (!r.data) continue;
      const v = r.data;
      out.push(
        isFullAttritionView(v)
          ? {
              employeeId: v.employeeId,
              employeeName: v.employeeName,
              riskTier: v.riskTier,
              recommendedActions: v.recommendedActions,
              scoredAt: v.scoredAt,
            }
          : v,
      );
    }
    // Most urgent tier first.
    return out.sort((a, b) => TIER_SEVERITY[a.riskTier] - TIER_SEVERITY[b.riskTier]);
  }, [results]);

  const loading = results.some((r) => r.isLoading);
  const errored = results.filter((r) => r.isError).length;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Array.from(
      new Set(
        raw
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    setIds(parsed);
  };

  return (
    <div className="space-y-5">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <label htmlFor="report-ids" className="text-sm font-medium">
            Your reports
          </label>
          <input
            id="report-ids"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            placeholder="Comma- or space-separated employee IDs"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={!raw.trim()}>
          View team
        </Button>
      </form>

      {ids.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Enter your direct reports&apos; employee IDs to see their retention risk
          level and suggested talking points.
        </p>
      ) : loading && reports.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading team…</p>
      ) : reports.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No risk data available for those employees (they may have opted out, or
          have no current score).
        </p>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => (
            <ReportCard key={r.employeeId} report={r} />
          ))}
        </ul>
      )}

      {errored > 0 ? (
        <p className="text-xs text-muted-foreground">
          {errored} employee{errored === 1 ? "" : "s"} could not be loaded (opted
          out, no current score, or not found).
        </p>
      ) : null}
    </div>
  );
}

function ReportCard({ report }: { report: ManagerAttritionView }) {
  const attention = report.riskTier === "CRITICAL" || report.riskTier === "HIGH";
  return (
    <li
      className={cn(
        "rounded-lg border bg-card p-4",
        attention && "border-amber-600/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">
            {report.employeeName ?? (
              <span className="font-mono text-xs text-muted-foreground">
                {report.employeeId.slice(0, 8)}…
              </span>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Updated {new Date(report.scoredAt).toLocaleDateString()}
          </p>
        </div>
        <RiskTierBadge tier={report.riskTier} />
      </div>

      {report.recommendedActions.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Suggested talking points
          </p>
          <ul className="list-inside list-disc space-y-1 text-sm text-foreground">
            {report.recommendedActions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No specific recommendations at this time.
        </p>
      )}
    </li>
  );
}
