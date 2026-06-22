import Link from "next/link";

import { MonitorDashboard } from "./monitor-dashboard";

export const dynamic = "force-dynamic";

/**
 * Module 9 — the org workflow MONITOR (ADMIN / HRBP).
 *
 * A thin Server Component wrapper. The client `MonitorDashboard` reads the
 * `WorkflowMonitor` (instances grouped by status, the org-wide overdue-task
 * count, and recent instances). The view is role-gated to ADMIN / HRBP
 * server-side; for a non-privileged viewer the API returns 403 and the dashboard
 * renders an access notice. All wire shapes come from `@peopleos/schemas`.
 */
export default function WorkflowMonitorPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Workflow monitor
          </h1>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/workflows" className="hover:text-foreground">
              Templates
            </Link>
            <Link href="/workflows/tasks" className="hover:text-foreground">
              My tasks
            </Link>
          </nav>
        </div>
        <p className="text-sm text-muted-foreground">
          An operations view of every workflow instance in the org — counts by
          status, the total overdue tasks the worker tick will escalate, and the
          most recent instances. People-ops view (ADMIN / HRBP).
        </p>
      </section>

      <MonitorDashboard />
    </div>
  );
}
