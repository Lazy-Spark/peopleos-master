import type { TaskOutcome, WorkflowTask } from "@peopleos/schemas";

/**
 * Shared display helpers for Module 9 workflow tasks. Kept in one place so the
 * task timeline, the inbox, and the monitor format dues / outcomes identically.
 * No wire shapes are declared here — everything is derived from the frozen
 * `WorkflowTask` / `TaskOutcome` contracts.
 */

/** A task is overdue when it has a due date in the past and is not yet done. */
export function isTaskOverdue(task: WorkflowTask, now: number = Date.now()): boolean {
  if (task.dueAt == null) return false;
  if (task.status === "COMPLETED" || task.status === "SKIPPED") return false;
  return new Date(task.dueAt).getTime() < now;
}

/** Human-readable due string, with a relative hint ("in 3h" / "2d overdue"). */
export function formatDue(dueAt: string | null, now: number = Date.now()): string {
  if (dueAt == null) return "No due date";
  const due = new Date(dueAt).getTime();
  const diffMs = due - now;
  const abs = Math.abs(diffMs);
  const hours = Math.round(abs / 3_600_000);
  const rel =
    hours < 1
      ? "under 1h"
      : hours < 48
        ? `${hours}h`
        : `${Math.round(hours / 24)}d`;
  const when = new Date(dueAt).toLocaleString();
  return diffMs >= 0 ? `Due in ${rel} (${when})` : `${rel} overdue (${when})`;
}

export const OUTCOME_LABEL: Record<TaskOutcome, string> = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
  DONE: "Done",
};
