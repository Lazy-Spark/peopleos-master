import Link from "next/link";

import { InstanceMonitor } from "./instance-monitor";

export const dynamic = "force-dynamic";

/**
 * Module 9 — a single workflow instance MONITOR.
 *
 * A thin Server Component wrapper. The client `InstanceMonitor` reads the
 * `WorkflowInstanceDetail` live (status, current step, the task TIMELINE with
 * overdue tasks highlighted) and offers a Cancel action. It refetches on an
 * interval so transitions driven by the worker tick (SLA escalation, timer
 * firing, an inline auto step advancing) surface without a manual reload. All
 * wire shapes come from `@peopleos/schemas`.
 */
export default function WorkflowInstancePage({
  params,
}: {
  params: { id: string };
}) {
  return (
    <div className="space-y-6">
      <Link
        href="/workflows"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to templates
      </Link>
      <InstanceMonitor instanceId={params.id} />
    </div>
  );
}
