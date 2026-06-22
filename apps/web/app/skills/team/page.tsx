import * as React from "react";

import { TeamSkillMapView } from "./team-skill-map";

export const dynamic = "force-dynamic";

/**
 * Module 6b — Team skill map route shell.
 *
 * A thin Server Component wrapper around the client `TeamSkillMapView` (which uses
 * `useSearchParams` to resolve the `?manager=` id, so it needs a Suspense
 * boundary). The view renders the members × skills heatmap, the bus-factor list
 * (skills held by exactly one report), and the bench-strength list — all from the
 * API-computed `TeamSkillMap` contract.
 */
export default function TeamSkillMapPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Team skill map</h1>
        <p className="text-sm text-muted-foreground">
          A manager-facing heatmap of the team&apos;s skills with bus-factor flags
          (single-holder skills) and bench strength. Computed server-side from the
          tenant-scoped skill graph.
        </p>
      </section>

      <React.Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <TeamSkillMapView />
      </React.Suspense>
    </div>
  );
}
