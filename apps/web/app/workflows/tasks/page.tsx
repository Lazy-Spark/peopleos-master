import Link from "next/link";

import { MyTasks } from "./my-tasks";

export const dynamic = "force-dynamic";

/**
 * Module 9 — "My tasks" inbox.
 *
 * A thin Server Component wrapper. The client `MyTasks` reads the human
 * tasks/approvals assigned to me or my role (`api.listMyWorkflowTasks`) and
 * completes them (approve / reject / mark done) via the frozen
 * `CompleteTaskRequest`. The API authorises every completion server-side (only
 * the assignee / their role, or ADMIN / HRBP). All wire shapes come from
 * `@peopleos/schemas`.
 */
export default function WorkflowTasksPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">My tasks</h1>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/workflows" className="hover:text-foreground">
              Templates
            </Link>
            <Link href="/workflows/monitor" className="hover:text-foreground">
              Monitor
            </Link>
          </nav>
        </div>
        <p className="text-sm text-muted-foreground">
          The workflow approvals and checklist tasks waiting on you — directly
          assigned or routed to your role. Overdue items are highlighted. Acting
          on a task advances its workflow instance.
        </p>
      </section>

      <MyTasks />
    </div>
  );
}
