"use client";

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { InventoryTable } from "@/components/skills/inventory-table";
import { KpiTile } from "@/components/analytics/kpi-tile";
import { api, ApiClientError } from "@/lib/api";
import type { SkillInventory as SkillInventoryT } from "@peopleos/schemas";

/**
 * SkillInventoryView (Module 6c, client) — org-wide skill supply vs demand.
 *
 * Fetches `api.getSkillInventory` and renders the supply/demand/gap table (gapped
 * skills first, each with an inline AI "Build vs buy" action) plus headline KPIs:
 * the org `talentDensityIndex` (% meeting their role's bar) and the count of
 * gapped skills. All numbers are API-computed from the tenant-scoped skill graph.
 */

/** A nullable unit score [0,1] → "73%" or "—" when not derivable. */
function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function SkillInventoryView() {
  const inventory = useQuery<SkillInventoryT, Error>({
    queryKey: ["skills", "inventory"],
    queryFn: () => api.getSkillInventory(),
  });

  if (inventory.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading skill inventory…</p>;
  }

  if (inventory.isError || !inventory.data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {inventory.error instanceof ApiClientError
          ? `${inventory.error.code}: ${inventory.error.message}`
          : "Could not load the skill inventory. Is the API running on NEXT_PUBLIC_API_URL?"}
      </div>
    );
  }

  const data = inventory.data;
  const gappedCount = data.items.filter((i) => i.gap > 0).length;
  const surplusCount = data.items.filter((i) => i.gap < 0).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Talent density"
          value={pct(data.talentDensityIndex)}
          hint="Employees meeting / exceeding their role's skill bar"
        />
        <KpiTile
          label="Gapped skills"
          value={String(gappedCount)}
          hint="Demand exceeds supply"
          tone={gappedCount > 0 ? "alert" : "default"}
        />
        <KpiTile
          label="Surplus skills"
          value={String(surplusCount)}
          hint="Supply exceeds open demand"
        />
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Supply vs demand</h2>
        <p className="text-xs text-muted-foreground">
          Gapped skills (demand &gt; supply) are listed first and carry a
          build-vs-buy recommendation. Surplus skills (supply &gt; demand) read
          green.
        </p>
        <InventoryTable items={data.items} />
      </section>
    </div>
  );
}
