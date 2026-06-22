import * as React from "react";

import { cn } from "@/lib/utils";
import type { InstanceStatus, TaskStatus } from "@peopleos/schemas";

/**
 * StatusBadge — the Module 9 workflow status pill, for both the durable
 * `InstanceStatus` (RUNNING → CANCELLED) and the human-task `TaskStatus`
 * (PENDING → OVERDUE). Both enums come from `@peopleos/schemas`; the badge maps
 * each value to a severity colour so the monitor and the inbox read the same.
 *
 * Colour intent: in-flight states are blue/amber, terminal-good is green,
 * terminal-bad (FAILED / CANCELLED / OVERDUE / ESCALATED) is red/amber. SKIPPED
 * is muted (a step the engine bypassed via a branch).
 */
const INSTANCE_CLASS: Record<InstanceStatus, string> = {
  RUNNING: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  WAITING: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  COMPLETED: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
  FAILED: "border-destructive/40 bg-destructive/10 text-destructive",
  CANCELLED: "border-muted-foreground/30 bg-muted text-muted-foreground",
};

const INSTANCE_LABEL: Record<InstanceStatus, string> = {
  RUNNING: "Running",
  WAITING: "Waiting",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const TASK_CLASS: Record<TaskStatus, string> = {
  PENDING: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  IN_PROGRESS: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  COMPLETED: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
  SKIPPED: "border-muted-foreground/30 bg-muted text-muted-foreground",
  ESCALATED: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  OVERDUE: "border-destructive/40 bg-destructive/10 text-destructive",
};

const TASK_LABEL: Record<TaskStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  SKIPPED: "Skipped",
  ESCALATED: "Escalated",
  OVERDUE: "Overdue",
};

type Props =
  | { kind: "instance"; status: InstanceStatus; className?: string }
  | { kind: "task"; status: TaskStatus; className?: string };

export function StatusBadge(props: Props): React.ReactElement {
  const { className } = props;
  const cls =
    props.kind === "instance"
      ? INSTANCE_CLASS[props.status]
      : TASK_CLASS[props.status];
  const label =
    props.kind === "instance"
      ? INSTANCE_LABEL[props.status]
      : TASK_LABEL[props.status];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        cls,
        className,
      )}
    >
      {label}
    </span>
  );
}

/** Instance-status ordering for grouping the monitor (in-flight first). */
export const INSTANCE_STATUS_ORDER: Record<InstanceStatus, number> = {
  RUNNING: 0,
  WAITING: 1,
  COMPLETED: 2,
  FAILED: 3,
  CANCELLED: 4,
};

export { INSTANCE_LABEL, TASK_LABEL };
