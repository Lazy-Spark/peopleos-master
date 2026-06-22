"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./status-badge";
import { StepTypeBadge } from "./step-type-badge";
import { formatDue, isTaskOverdue } from "./task-display";
import type { CompleteTaskRequest, WorkflowTask } from "@peopleos/schemas";

/**
 * TaskInbox — the "My tasks" inbox of human tasks/approvals assigned to me or my
 * role. Each row exposes the completion action appropriate to the step type: an
 * APPROVAL offers Approve / Reject (recording the frozen `TaskOutcome`
 * APPROVED / REJECTED), every other human step offers a single "Mark done"
 * (DONE). The optional note is passed through in the frozen `CompleteTaskRequest`.
 *
 * Completion is presentational here — the parent owns the mutation (so it can
 * invalidate the right queries) and passes `onComplete` + the in-flight task id.
 * The API AUTHORISES the completion server-side (only the assignee / their role
 * or ADMIN / HRBP); a rejected attempt surfaces as the parent's mutation error.
 */
export function TaskInbox({
  tasks,
  onComplete,
  pendingTaskId,
  className,
}: {
  tasks: WorkflowTask[];
  onComplete: (taskId: string, body: CompleteTaskRequest) => void;
  /** The task whose completion is currently in flight (disables its buttons). */
  pendingTaskId?: string | null;
  className?: string;
}): React.ReactElement {
  if (tasks.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Your inbox is clear — no workflow tasks are assigned to you right now.
      </p>
    );
  }

  return (
    <ul className={cn("space-y-3", className)}>
      {tasks.map((task) => (
        <InboxRow
          key={task.id}
          task={task}
          onComplete={onComplete}
          pending={pendingTaskId === task.id}
        />
      ))}
    </ul>
  );
}

function InboxRow({
  task,
  onComplete,
  pending,
}: {
  task: WorkflowTask;
  onComplete: (taskId: string, body: CompleteTaskRequest) => void;
  pending: boolean;
}) {
  const [note, setNote] = React.useState("");
  const overdue = isTaskOverdue(task);
  const isApproval = task.type === "APPROVAL";
  // Already-resolved tasks are shown read-only (the inbox should mostly carry
  // open work, but a refetch may briefly include a just-completed row).
  const done = task.status === "COMPLETED" || task.status === "SKIPPED";

  const submit = (outcome: CompleteTaskRequest["outcome"]) => {
    const body: CompleteTaskRequest = {
      ...(outcome ? { outcome } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    onComplete(task.id, body);
  };

  return (
    <li
      className={cn(
        "rounded-lg border p-4",
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

      <p
        className={cn(
          "mt-1 text-xs text-muted-foreground",
          overdue && "font-medium text-destructive",
        )}
      >
        {formatDue(task.dueAt)}
        {task.assigneeRole ? ` · for ${task.assigneeRole}` : ""}
      </p>

      {!done ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              isApproval
                ? "Optional note for your decision…"
                : "Optional note…"
            }
            rows={2}
            maxLength={2000}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex flex-wrap gap-2">
            {isApproval ? (
              <>
                <Button
                  size="sm"
                  onClick={() => submit("APPROVED")}
                  disabled={pending}
                >
                  {pending ? "Submitting…" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => submit("REJECTED")}
                  disabled={pending}
                >
                  Reject
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={() => submit("DONE")}
                disabled={pending}
              >
                {pending ? "Submitting…" : "Mark done"}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}
