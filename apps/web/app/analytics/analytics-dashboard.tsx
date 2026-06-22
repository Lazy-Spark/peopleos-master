"use client";

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { AskYourData } from "@/components/analytics/ask-your-data";
import { FunnelChart } from "@/components/analytics/funnel-chart";
import { HeadcountBars } from "@/components/analytics/headcount-bars";
import { KpiTile } from "@/components/analytics/kpi-tile";
import { NarrativePanel } from "@/components/analytics/narrative-panel";
import { PendingSection } from "@/components/analytics/pending-section";
import { SpanOfControlTable } from "@/components/analytics/span-of-control-table";
import { api, ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AnalyticsNarrativeResponse,
  DashboardMetrics,
  PromotionByLevel,
  SlaBreach,
} from "@peopleos/schemas";

/**
 * Module 5 — Workforce Analytics Dashboard (client).
 *
 * Composes the API-computed `DashboardMetrics` snapshot
 * (`api.getAnalyticsDashboard`) with the AI narrative
 * (`api.getAnalyticsNarrative`) and the "Ask your data" surface
 * (`api.askAnalytics`). Sections:
 *   5a Recruiting funnel    — byStage + conversion, KPI tiles, source-of-hire, SLA breaches
 *   5b Workforce composition — headcount bars, employment split, span of control, promotion, new-hire success
 *   5c Engagement / 5d Skills — render an "Unlocks with Module 7 / Module 6" placeholder when `available` is false
 *   5e AI narrative + Ask your data
 *
 * All numbers come from the contract; this component only formats and lays out.
 */

// ── Formatting helpers (display-only; never derive metric values) ──────────────

/** A nullable unit score [0,1] → "73%" or "—" when not derivable. */
function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/** A nullable day count → "32" (rounded) or "—" when not yet computable. */
function days(value: number | null): string {
  return value === null ? "—" : String(Math.round(value));
}

export function AnalyticsDashboard() {
  const dashboard = useQuery<DashboardMetrics, Error>({
    queryKey: ["analytics", "dashboard"],
    queryFn: () => api.getAnalyticsDashboard(),
  });

  // The narrative is a derived view of the snapshot; only fetch it once the
  // snapshot has loaded, and don't fail the whole page if narration is down.
  const narrative = useQuery<AnalyticsNarrativeResponse, Error>({
    queryKey: ["analytics", "narrative"],
    queryFn: () => api.getAnalyticsNarrative(),
    enabled: dashboard.isSuccess,
  });

  if (dashboard.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading analytics…</p>;
  }

  if (dashboard.isError || !dashboard.data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {dashboard.error instanceof ApiClientError
          ? `${dashboard.error.code}: ${dashboard.error.message}`
          : "Could not load analytics. Is the API running on NEXT_PUBLIC_API_URL?"}
      </div>
    );
  }

  const m = dashboard.data;
  const { recruiting, workforce, engagement, skills } = m;
  const generated = new Date(m.generatedAt);

  return (
    <div className="space-y-10">
      <p className="text-xs text-muted-foreground">
        Snapshot generated{" "}
        {Number.isNaN(generated.getTime())
          ? m.generatedAt
          : generated.toLocaleString()}
      </p>

      {/* ── 5e · AI narrative (lead with the executive insight) ──────────── */}
      <section className="space-y-3">
        <SectionHeading title="AI narrative insights" subtitle="5e" />
        {narrative.isLoading ? (
          <div className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">
            Generating the weekly narrative…
          </div>
        ) : narrative.isError || !narrative.data ? (
          <div className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">
            The AI narrative is temporarily unavailable. The metrics below are
            unaffected.
          </div>
        ) : (
          <NarrativePanel narrative={narrative.data} />
        )}
        <AskYourData />
      </section>

      {/* ── 5a · Recruiting funnel health ───────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeading title="Recruiting funnel health" subtitle="5a" />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Open roles"
            value={String(recruiting.openRoles)}
            hint={`${recruiting.totalApplications.toLocaleString()} total applications`}
          />
          <KpiTile
            label="Time to fill"
            value={days(recruiting.timeToFillDays)}
            unit="days"
            hint="Open → close (filled roles)"
          />
          <KpiTile
            label="Time to hire"
            value={days(recruiting.timeToHireDays)}
            unit="days"
            hint="Application → hired"
          />
          <KpiTile
            label="Offer acceptance"
            value={pct(recruiting.offerAcceptanceRate)}
            tone={
              recruiting.offerAcceptanceRate !== null &&
              recruiting.offerAcceptanceRate < 0.7
                ? "alert"
                : "default"
            }
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardTitle>Pipeline by stage</CardTitle>
            <FunnelChart
              byStage={recruiting.byStage}
              conversionRates={recruiting.conversionRates}
            />
          </Card>

          <Card>
            <CardTitle>Source of hire</CardTitle>
            <HeadcountBars
              data={recruiting.sourceOfHire.map((s) => ({
                key: SOURCE_LABEL[s.source] ?? s.source,
                count: s.count,
              }))}
            />
          </Card>
        </div>

        <Card>
          <CardTitle>
            SLA breaches
            {recruiting.slaBreaches.length > 0 ? (
              <span className="ml-2 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                {recruiting.slaBreaches.length} overdue
              </span>
            ) : null}
          </CardTitle>
          <SlaBreachList breaches={recruiting.slaBreaches} />
        </Card>
      </section>

      {/* ── 5b · Workforce composition ──────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeading title="Workforce composition" subtitle="5b" />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Total headcount"
            value={workforce.totalHeadcount.toLocaleString()}
          />
          <KpiTile
            label="New-hire success"
            value={pct(workforce.newHireSuccessRate)}
            hint="Past 90-day mark, good rating"
            tone={
              workforce.newHireSuccessRate !== null &&
              workforce.newHireSuccessRate >= 0.8
                ? "good"
                : "default"
            }
          />
          <KpiTile
            label="Internal mobility"
            value={pct(workforce.internalMobilityRate)}
            hint="Roles filled internally"
          />
          <KpiTile
            label="Managers flagged"
            value={String(
              workforce.spanOfControl.filter((s) => s.flag !== "OK").length,
            )}
            hint="Wide / narrow span of control"
            tone={
              workforce.spanOfControl.some((s) => s.flag === "WIDE")
                ? "alert"
                : "default"
            }
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardTitle>Headcount by department</CardTitle>
            <HeadcountBars data={workforce.byDepartment} />
          </Card>
          <Card>
            <CardTitle>Headcount by location</CardTitle>
            <HeadcountBars data={workforce.byLocation} />
          </Card>
          <Card>
            <CardTitle>Headcount by level</CardTitle>
            <HeadcountBars data={workforce.byLevel} orientation="vertical" />
          </Card>
          <Card>
            <CardTitle>Employment type</CardTitle>
            <HeadcountBars
              data={workforce.byEmploymentType}
              orientation="vertical"
            />
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardTitle>Span of control</CardTitle>
            <p className="mb-2 text-xs text-muted-foreground">
              Wide (&gt;8 reports) and narrow (&lt;3) managers are flagged for review.
            </p>
            <SpanOfControlTable rows={workforce.spanOfControl} />
          </Card>
          <Card>
            <CardTitle>Promotion rate by level</CardTitle>
            <p className="mb-2 text-xs text-muted-foreground">
              Bottleneck detection — low rates at a level may indicate stalled
              progression.
            </p>
            <PromotionByLevelTable rows={workforce.promotionRateByLevel} />
          </Card>
        </div>
      </section>

      {/* ── 5c · Engagement & retention (gated on Module 7) ──────────────── */}
      <section className="space-y-4">
        <SectionHeading title="Engagement & retention" subtitle="5c" />
        {engagement.available ? (
          <EngagementContent engagement={engagement} />
        ) : (
          <PendingSection
            unlocksWith="Module 7 — Attrition Prediction"
            pendingReason={engagement.pendingReason}
          />
        )}
      </section>

      {/* ── 5d · Skills & talent density (gated on Module 6) ─────────────── */}
      <section className="space-y-4">
        <SectionHeading title="Skills & talent density" subtitle="5d" />
        {skills.available ? (
          <SkillsContent skills={skills} />
        ) : (
          <PendingSection
            unlocksWith="Module 6 — Skill Graph"
            pendingReason={skills.pendingReason}
          />
        )}
      </section>
    </div>
  );
}

// ── 5c / 5d content (rendered only when `available`) ──────────────────────────
// When Modules 6/7 land these light up; until then the contracts return
// available:false and the dashboard renders <PendingSection> above instead.

function EngagementContent({
  engagement,
}: {
  engagement: DashboardMetrics["engagement"];
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardTitle>Flight risk by tier</CardTitle>
        <HeadcountBars
          data={engagement.attritionByTier.map((t) => ({
            key: t.tier,
            count: t.count,
          }))}
          orientation="vertical"
        />
      </Card>
      <Card>
        <CardTitle>Regrettable attrition</CardTitle>
        <p className="text-2xl font-semibold tabular-nums">
          {engagement.regrettableCount}
        </p>
        <p className="text-xs text-muted-foreground">
          Key-person losses tracked this period.
        </p>
      </Card>
    </div>
  );
}

function SkillsContent({ skills }: { skills: DashboardMetrics["skills"] }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardTitle>Skill gaps (required vs supply)</CardTitle>
        <HeadcountBars
          data={skills.skillGaps.map((g) => ({ key: g.skill, count: g.gap }))}
        />
      </Card>
      <Card>
        <CardTitle>Bus-factor risks</CardTitle>
        <HeadcountBars
          data={skills.busFactorRisks.map((r) => ({
            key: r.skill,
            count: r.holders,
          }))}
        />
      </Card>
    </div>
  );
}

// ── Small local presentational helpers ────────────────────────────────────────

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b pb-2">
      <h2 className="text-lg font-medium">{title}</h2>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {subtitle}
      </span>
    </div>
  );
}

function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-card p-4", className)}>{children}</div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 flex items-center text-sm font-medium text-foreground">
      {children}
    </h3>
  );
}

function SlaBreachList({ breaches }: { breaches: SlaBreach[] }) {
  if (breaches.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No roles past their SLA threshold. Pipeline is on track.
      </p>
    );
  }
  // Most overdue first.
  const sorted = [...breaches].sort((a, b) => b.daysOpen - a.daysOpen);
  return (
    <ul className="divide-y rounded-md border border-destructive/30">
      {sorted.map((b) => (
        <li
          key={b.jobId}
          className="flex items-center justify-between gap-3 px-3 py-2"
        >
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {b.title}
          </span>
          <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium tabular-nums text-destructive">
            {b.daysOpen} days open
          </span>
        </li>
      ))}
    </ul>
  );
}

function PromotionByLevelTable({ rows }: { rows: PromotionByLevel[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No promotion data yet.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Level</th>
            <th className="px-3 py-2 text-right font-medium">Promoted</th>
            <th className="px-3 py-2 text-right font-medium">Rate</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.level}>
              <td className="px-3 py-2">{LEVEL_LABEL[r.level] ?? r.level}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.promoted} / {r.total}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {Math.round(r.rate * 100)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Enum display labels (frozen enums → human strings) ────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  DIRECT: "Direct",
  REFERRAL: "Referral",
  LINKEDIN: "LinkedIn",
  INDEED: "Indeed",
  GLASSDOOR: "Glassdoor",
  JOB_BOARD: "Job board",
  AGENCY: "Agency",
  EMAIL_APPLY: "Email apply",
  IMPORT: "Import",
};

const LEVEL_LABEL: Record<string, string> = {
  INTERN: "Intern",
  JUNIOR: "Junior",
  MID: "Mid",
  SENIOR: "Senior",
  STAFF: "Staff",
  PRINCIPAL: "Principal",
  MANAGER: "Manager",
  DIRECTOR: "Director",
  VP: "VP",
  EXEC: "Exec",
};
