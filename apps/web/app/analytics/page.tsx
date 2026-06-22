import * as React from "react";

import { AnalyticsDashboard } from "./analytics-dashboard";

/**
 * Module 5 — Workforce Analytics Dashboard route shell.
 *
 * A thin Server Component wrapper. The dashboard itself is a Client Component
 * (`AnalyticsDashboard`) because it composes live TanStack Query reads
 * (`api.getAnalyticsDashboard` + `api.getAnalyticsNarrative`) with the
 * interactive "Ask your data" surface (`api.askAnalytics`) and Recharts
 * visualisations. All wire shapes come from `@peopleos/schemas`.
 */
export const dynamic = "force-dynamic";

export default function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Workforce Analytics
        </h1>
        <p className="text-sm text-muted-foreground">
          A real-time view of workforce health — recruiting funnel, composition,
          engagement &amp; skills — with AI narrative insights. Metrics are
          computed server-side from tenant-scoped data; the AI narrates and
          answers grounded only in those metrics.
        </p>
      </section>

      <AnalyticsDashboard />
    </div>
  );
}
