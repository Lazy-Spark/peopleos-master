import Link from "next/link";

import { KpiTile } from "@/components/analytics/kpi-tile";
import { api, ApiClientError } from "@/lib/api";
import type { MobilityAnalytics } from "@peopleos/schemas";

export const dynamic = "force-dynamic";

/** A nullable unit score [0,1] → "73%" or "—" when not derivable. */
function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * Module 8 — internal-mobility analytics (HRBP / leadership).
 *
 * Server Component: fetches `api.getMobilityAnalytics` → `MobilityAnalytics` and
 * renders the headline KPIs (internal fill rate, internal mobility rate, open
 * internal roles, total internal applications, hired internally) plus the
 * internal-hires-by-department breakdown. Every number is API-computed and
 * tenant-scoped; this is the source of Module 5's 5b `internalMobilityRate`. The
 * UI never derives metrics — null rates render as "—".
 */
export default async function MobilityAnalyticsPage() {
  let data: MobilityAnalytics;
  try {
    data = await api.getMobilityAnalytics();
  } catch (err) {
    return (
      <div className="space-y-4">
        <Header />
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {err instanceof ApiClientError
            ? `${err.code}: ${err.message}`
            : "Failed to load mobility analytics. Is the API running on NEXT_PUBLIC_API_URL?"}
        </div>
      </div>
    );
  }

  const maxDept = Math.max(1, ...data.byDepartment.map((d) => d.internalHires));

  return (
    <div className="space-y-6">
      <Header />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiTile
          label="Internal fill rate"
          value={pct(data.internalFillRate)}
          hint="Internal hires / all hires"
          tone={
            data.internalFillRate !== null && data.internalFillRate >= 0.3
              ? "good"
              : "default"
          }
        />
        <KpiTile
          label="Internal mobility rate"
          value={pct(data.internalMobilityRate)}
          hint="Internal moves / headcount"
        />
        <KpiTile
          label="Open internal roles"
          value={String(data.openInternalRoles)}
          hint="Roles accepting internal applications"
        />
        <KpiTile
          label="Internal applications"
          value={String(data.totalInternalApplications)}
          hint="Total, all statuses"
        />
        <KpiTile
          label="Hired internally"
          value={String(data.hiredInternally)}
          hint="Applications that reached HIRED"
          tone={data.hiredInternally > 0 ? "good" : "default"}
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Internal hires by department</h2>
        {data.byDepartment.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No internal hires recorded yet.
          </p>
        ) : (
          <ul className="space-y-2 rounded-lg border p-4">
            {data.byDepartment.map((d) => (
              <li key={d.department} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">{d.department}</span>
                  <span className="font-medium tabular-nums">
                    {d.internalHires}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(d.internalHires / maxDept) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Header() {
  return (
    <section className="space-y-1">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Mobility analytics
        </h1>
        <Link
          href="/mobility"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Internal roles
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        How much of the org's hiring and movement happens from within. Feeds the
        workforce dashboard's internal-mobility rate. HRBP / leadership view.
      </p>
    </section>
  );
}
