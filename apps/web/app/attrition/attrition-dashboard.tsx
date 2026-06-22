"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { AttritionHeatmap, DIMENSION_LABEL, type HeatmapDimension } from "@/components/attrition/attrition-heatmap";
import { BiasAuditPanel } from "@/components/attrition/bias-audit-panel";
import { DriverList } from "@/components/attrition/driver-list";
import { FlightRiskList } from "@/components/attrition/flight-risk-list";
import { RiskTierBadge, TIER_LABEL } from "@/components/attrition/risk-tier-badge";
import { api, ApiClientError, isFullAttritionView } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AttritionEmployeeView,
  AttritionSummary,
  AttritionTierCount,
  RiskTier,
  RunScoringResponse,
} from "@peopleos/schemas";

/**
 * AttritionDashboard (Module 7, HRBP / leadership client).
 *
 * Composes:
 *   - the org `AttritionSummary` (`api.getAttritionSummary`) → tier distribution,
 *     the department/level/team risk heatmap, the regrettable-attrition count
 *     (strong performers at high risk), the scored count, and the opted-out count;
 *   - a "run scoring" action (`api.runAttritionScoring`) → re-scores the org
 *     (honouring opt-outs) and refreshes the summary;
 *   - a flight-risk roster (CRITICAL/HIGH) built from the FULL `AttritionEmployeeView`
 *     reads (`api.getEmployeeAttrition`) for an HRBP-supplied set of employees,
 *     each drilling down into drivers + narrative + recommended actions;
 *   - the monthly bias-audit panel (`api.attritionBiasAudit`).
 *
 * GOVERNANCE: this is the HR/ADMIN surface — the only place the raw score + SHAP
 * drivers are shown. The score is advisory and is never shown to the employee.
 */
export function AttritionDashboard() {
  const queryClient = useQueryClient();

  const summary = useQuery<AttritionSummary, Error>({
    queryKey: ["attrition", "summary"],
    queryFn: () => api.getAttritionSummary(),
  });

  const runScoring = useMutation<RunScoringResponse, Error, void>({
    mutationFn: () => api.runAttritionScoring(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["attrition", "summary"] });
      void queryClient.invalidateQueries({ queryKey: ["attrition", "employee"] });
    },
  });

  return (
    <div className="space-y-8">
      {/* ── Run scoring + headline counts ──────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading title="Overview" />
          <div className="flex items-center gap-3">
            {runScoring.data ? (
              <span className="text-xs text-muted-foreground">
                Scored {runScoring.data.scoredCount} ·{" "}
                {runScoring.data.skippedOptedOut} opted out · model{" "}
                {runScoring.data.modelVersion}
              </span>
            ) : null}
            <Button
              size="sm"
              onClick={() => runScoring.mutate()}
              disabled={runScoring.isPending}
            >
              {runScoring.isPending ? "Scoring…" : "Run scoring"}
            </Button>
          </div>
        </div>
        {runScoring.isError ? (
          <p className="text-xs text-destructive">
            {runScoring.error instanceof ApiClientError
              ? `${runScoring.error.code}: ${runScoring.error.message}`
              : "Could not run scoring."}
          </p>
        ) : null}

        {summary.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading attrition summary…</p>
        ) : summary.isError || !summary.data ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {summary.error instanceof ApiClientError
              ? `${summary.error.code}: ${summary.error.message}`
              : "Could not load the attrition summary. Is the API running on NEXT_PUBLIC_API_URL?"}
          </div>
        ) : (
          <SummaryContent summary={summary.data} />
        )}
      </section>

      {/* ── Flight-risk roster + drill-down ────────────────────────────────── */}
      <FlightRiskSection />

      {/* ── Bias audit ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeading title="Governance" />
        <BiasAuditPanel />
      </section>
    </div>
  );
}

// ── Summary (counts + tier distribution + heatmap) ────────────────────────────

function SummaryContent({ summary }: { summary: AttritionSummary }) {
  const [dimension, setDimension] = React.useState<HeatmapDimension>("DEPARTMENT");
  const generated = new Date(summary.generatedAt);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CountTile label="Scored" value={summary.scoredCount} hint="Employees with a current score" />
        <CountTile
          label="Opted out"
          value={summary.optedOutCount}
          hint="Excluded from profiling (their choice)"
        />
        <CountTile
          label="Regrettable"
          value={summary.regrettableCount}
          hint="Strong performers at high risk"
          tone={summary.regrettableCount > 0 ? "alert" : "default"}
        />
        <CountTile
          label="At critical/high"
          value={countAtFlightRisk(summary.byTier)}
          hint="Flight-risk headcount"
          tone={countAtFlightRisk(summary.byTier) > 0 ? "alert" : "default"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-4 lg:col-span-1">
          <h3 className="mb-3 text-sm font-medium">Risk distribution</h3>
          <TierDistribution byTier={summary.byTier} total={summary.scoredCount} />
        </div>

        <div className="rounded-lg border bg-card p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Risk heatmap</h3>
            <div className="flex items-center gap-1">
              {(["DEPARTMENT", "LEVEL", "TEAM"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDimension(d)}
                  aria-pressed={dimension === d}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    dimension === d
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {DIMENSION_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Headcount per {DIMENSION_LABEL[dimension].toLowerCase()} at each risk
            tier; deeper red = more people at higher risk. Aggregate counts only —
            no individual scores.
          </p>
          <AttritionHeatmap cells={summary.heatmap} dimension={dimension} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Summary generated{" "}
        {Number.isNaN(generated.getTime())
          ? summary.generatedAt
          : generated.toLocaleString()}
        .
      </p>
    </div>
  );
}

function TierDistribution({
  byTier,
  total,
}: {
  byTier: ReadonlyArray<AttritionTierCount>;
  total: number;
}) {
  const order: RiskTier[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const lookup = new Map(byTier.map((t) => [t.tier, t.count]));
  const denom = total > 0 ? total : byTier.reduce((s, t) => s + t.count, 0) || 1;
  const BAR: Record<RiskTier, string> = {
    CRITICAL: "bg-destructive",
    HIGH: "bg-amber-600",
    MEDIUM: "bg-blue-600",
    LOW: "bg-emerald-600",
  };
  return (
    <ul className="space-y-2.5">
      {order.map((tier) => {
        const count = lookup.get(tier) ?? 0;
        const pct = Math.round((count / denom) * 100);
        return (
          <li key={tier} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2">
                <RiskTierBadge tier={tier} />
              </span>
              <span className="tabular-nums text-muted-foreground">
                {count} · {pct}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", BAR[tier])}
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ── Flight-risk roster + per-employee drill-down ──────────────────────────────

function FlightRiskSection() {
  const [raw, setRaw] = React.useState("");
  const [ids, setIds] = React.useState<string[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["attrition", "employee", id] as const,
      queryFn: () => api.getEmployeeAttrition(id),
    })),
  });

  // Keep only the FULL HR views (the redacted manager shape can't populate the
  // flight-risk roster — and HR/ADMIN always receive the full shape here).
  const fullViews = React.useMemo<AttritionEmployeeView[]>(() => {
    const out: AttritionEmployeeView[] = [];
    for (const r of results) {
      if (r.data && isFullAttritionView(r.data)) out.push(r.data);
    }
    return out;
  }, [results]);

  const selected = React.useMemo(
    () => fullViews.find((v) => v.employeeId === selectedId) ?? null,
    [fullViews, selectedId],
  );

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
    setSelectedId(null);
  };

  return (
    <section className="space-y-3">
      <SectionHeading title="Flight risk" />
      <p className="text-xs text-muted-foreground">
        Drill into specific employees to see their drivers, the AI narrative, and
        recommended retention actions. Enter the employee IDs to review (the API
        returns the full HR view for ADMIN/HRBP; other roles receive only the
        redacted tier + recommendation).
      </p>

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <label htmlFor="flight-ids" className="text-sm font-medium">
            Employee IDs
          </label>
          <input
            id="flight-ids"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            placeholder="Comma- or space-separated employee IDs"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={!raw.trim()}>
          Review
        </Button>
      </form>

      {ids.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Enter one or more employee IDs to build the flight-risk roster.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading scores…</p>
            ) : null}
            <FlightRiskList
              employees={fullViews}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            {errored > 0 ? (
              <p className="text-xs text-muted-foreground">
                {errored} ID{errored === 1 ? "" : "s"} could not be loaded (no
                score, opted out, or not found).
              </p>
            ) : null}
          </div>

          <div>
            {selected ? (
              <EmployeeDrillDown view={selected} />
            ) : (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Select an employee to see their drivers, narrative, and recommended
                actions.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function EmployeeDrillDown({ view }: { view: AttritionEmployeeView }) {
  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">
            {view.employeeName ?? (
              <span className="font-mono text-xs text-muted-foreground">
                {view.employeeId}
              </span>
            )}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Scored {new Date(view.scoredAt).toLocaleString()}
          </p>
        </div>
        <RiskTierBadge tier={view.riskTier} />
      </div>

      {/* Raw score — HR/ADMIN only (never shown to managers or the employee). */}
      <div className="rounded-md bg-muted/40 px-3 py-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Risk score (HR-only)
        </p>
        <p className="text-2xl font-semibold tabular-nums">
          {Math.round(view.riskScore * 100)}
          <span className="ml-1 text-sm font-normal text-muted-foreground">
            / 100 · {TIER_LABEL[view.riskTier]}
          </span>
        </p>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Top drivers
        </h4>
        <DriverList drivers={view.topDrivers} />
      </div>

      {view.narrative ? (
        <div className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            AI narrative
          </h4>
          <p className="whitespace-pre-line text-sm text-foreground">
            {view.narrative}
          </p>
        </div>
      ) : null}

      {view.recommendedActions.length > 0 ? (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recommended actions
          </h4>
          <ul className="list-inside list-disc space-y-1 text-sm text-foreground">
            {view.recommendedActions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="border-t pt-2 text-[11px] text-muted-foreground">
        Advisory only — use this to inform a supportive conversation, never an
        automated action. This score is never shown to the employee.
      </p>
    </div>
  );
}

// ── Small presentational helpers ──────────────────────────────────────────────

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="border-b pb-2">
      <h2 className="text-lg font-medium">{title}</h2>
    </div>
  );
}

function CountTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "default" | "alert";
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "alert" ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function countAtFlightRisk(byTier: ReadonlyArray<AttritionTierCount>): number {
  return byTier
    .filter((t) => t.tier === "CRITICAL" || t.tier === "HIGH")
    .reduce((s, t) => s + t.count, 0);
}
