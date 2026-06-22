import * as React from "react";

import { cn } from "@/lib/utils";
import { StatusBadge } from "./status-badge";
import { StepTypeBadge } from "./step-type-badge";
import { formatDue, isTaskOverdue, OUTCOME_LABEL } from "./task-display";
import type { WorkflowTask } from "@peopleos/schemas";

/**
 * TaskTimeline — the per-instance task TIMELINE (a `WorkflowTask[]`). Each row
 * shows the step type, name, assignee (role or user), due (with a relative
 * hint), status, and the recorded outcome (APPROVED / REJECTED / DONE) once
 * completed. Overdue tasks (a past due date on a still-open task) are highlighted
 * so the monitor surfaces SLA breaches the worker tick will escalate.
 *
 * Tasks are rendered in creation order (the order the engine materialised them as
 * it walked the DAG), which reads as a chronological timeline.
 */
export function TaskTimeline({
  tasks,
  className,
}: {
  tasks: WorkflowTask[];
  className?: string;
}): React.ReactElement {
  const ordered = React.useMemo(
    () =>
      [...tasks].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [tasks],
  );

  if (tasks.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
        No tasks yet — the instance has not reached a human step.
      </p>
    );
  }

  return (
    <ol className={cn("space-y-2", className)}>
      {ordered.map((task) => {
        const overdue = isTaskOverdue(task);
        const assignee =
          task.assigneeId != null
            ? "Assigned to a specific user"
            : task.assigneeRole != null
              ? `Role: ${task.assigneeRole}`
              : "Unassigned";
        return (
          <li
            key={task.id}
            className={cn(
              "rounded-lg border p-3",
              overdue && "border-destructive/40 bg-destructive/5",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <StepTypeBadge type={task.type} />
                <span className="font-medium">{task.name}</span>
              </div>
              <StatusBadge kind="task" status={task.status} />
            </div>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{assignee}</span>
              <span className={cn(overdue && "font-medium text-destructive")}>
                {formatDue(task.dueAt)}
              </span>
              {task.outcome != null ? (
                <span className="text-foreground">
                  Outcome: {OUTCOME_LABEL[task.outcome]}
                </span>
              ) : null}
              {task.completedAt != null ? (
                <span>
                  Completed {new Date(task.completedAt).toLocaleString()}
                </span>
              ) : null}
            </div>

            {task.note ? (
              <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Note: </span>
                {task.note}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
