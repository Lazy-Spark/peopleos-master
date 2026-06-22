"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { TaskInbox } from "@/components/workflows/task-inbox";
import { api, ApiClientError } from "@/lib/api";
import type { CompleteTaskRequest, WorkflowTask } from "@peopleos/schemas";

/**
 * MyTasks (Module 9, client) — owns the inbox data + the completion mutation.
 *
 * The presentational `TaskInbox` renders the rows and the approve / reject /
 * mark-done controls; this component reads the tasks (`api.listMyWorkflowTasks`)
 * and runs the completion (`api.completeWorkflowTask`), invalidating the inbox so
 * a completed task drops off and any newly-created downstream task appears. The
 * acting user + role are resolved server-side from the session — the client never
 * sends an assignee.
 */
export function MyTasks() {
  const queryClient = useQueryClient();

  const tasks = useQuery<WorkflowTask[], Error>({
    queryKey: ["workflows", "my-tasks"],
    queryFn: () => api.listMyWorkflowTasks(),
  });

  const complete = useMutation({
    mutationFn: ({
      taskId,
      body,
    }: {
      taskId: string;
      body: CompleteTaskRequest;
    }) => api.completeWorkflowTask(taskId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workflows", "my-tasks"],
      });
    },
  });

  if (tasks.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading your tasks…</p>;
  }

  if (tasks.isError || !tasks.data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {tasks.error instanceof ApiClientError
          ? `${tasks.error.code}: ${tasks.error.message}`
          : "Could not load your tasks. Is the API running on NEXT_PUBLIC_API_URL?"}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {complete.isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {complete.error instanceof ApiClientError
            ? `${complete.error.code}: ${complete.error.message}`
            : "Could not complete the task."}
        </div>
      ) : null}

      <TaskInbox
        tasks={tasks.data}
        onComplete={(taskId, body) => complete.mutate({ taskId, body })}
        pendingTaskId={complete.isPending ? complete.variables?.taskId : null}
      />
    </div>
  );
}
