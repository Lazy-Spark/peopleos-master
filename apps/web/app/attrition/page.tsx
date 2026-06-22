import * as React from "react";

import { AttritionDashboard } from "./attrition-dashboard";

/**
 * Module 7 — Attrition Prediction Engine (HRBP / leadership) route shell.
 *
 * A thin Server Component wrapper around the client `AttritionDashboard`, which
 * composes the org `AttritionSummary` (risk heatmap + regrettable / opted-out
 * counts), the flight-risk roster (CRITICAL/HIGH) with a "run scoring" action
 * and a per-employee drill-down (drivers + narrative + recommended actions), and
 * the monthly bias-audit panel.
 *
 * Governance, surfaced in the UI copy: the risk score is ADVISORY ONLY (no
 * automated HR action), and it is NEVER shown to the employee. Managers see only
 * the tier + recommendation (the redacted view at /attrition/team). All wire
 * shapes come from `@peopleos/schemas`.
 */
export const dynamic = "force-dynamic";

export default function AttritionPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Attrition risk (people-ops)
        </h1>
        <p className="text-sm text-muted-foreground">
          A retention-risk view to help you support employees before they leave —
          a department/level heatmap, a flight-risk roster, and the monthly bias
          audit. Risk is computed server-side from tenure, performance, team and
          skill signals only — never from a protected attribute.
        </p>
      </section>

      <div className="rounded-lg border border-amber-600/30 bg-amber-600/5 p-3 text-xs text-amber-800">
        <span className="font-medium">Advisory only.</span> These scores support a
        human conversation; they never trigger an automated HR action. The score
        is <span className="font-medium">never shown to the employee</span>, and
        employees may opt out of scoring entirely. Managers see only the risk tier
        and recommended talking points — never the raw score, the model drivers,
        or the underlying signals.
      </div>

      <AttritionDashboard />
    </div>
  );
}
