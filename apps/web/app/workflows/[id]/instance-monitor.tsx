"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/workflows/status-badge";
import { TaskTimeline } from "@/components/workflows/task-timeline";
import { isTaskOverdue } from "@/components/workflows/task-display";
import { api, ApiClientError } from "@/lib/api";
import type { WorkflowInstanceDetail } from "@peopleos/schemas";

/**
 * InstanceMonitor (Module 9, client) — the live monitor for one workflow
 * instance.
 *
 * Reads `WorkflowInstanceDetail` (the instance + its definition key/name + the
 * task timeline). It polls while the instance is in flight (RUNNING / WAITING) so
 * worker-tick transitions — SLA escalation, a timer firing, an auto step
 * advancing — appear without a reload. Cancel transitions the instance to
 * CANCELLED durably (ADMIN / HRBP, enforced server-side); an unauthorised attempt
 * surfaces as the mutation error.
 */
export function InstanceMonitor({ instanceId }: { instanceId: string }) {
  const queryClient = useQueryClient();

  const instance = useQuery<WorkflowInstanceDetail, Error>({
    queryKey: ["workflows", "instance", instanceId],
    queryFn: () => api.getWorkflowInstance(instanceId),
    // Poll while in flight so worker-tick changes surface; stop once terminal.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "RUNNING" || status === "WAITING" ? 10_000 : false;
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelWorkflowInstance(instanceId),
    onSuccess: (updated) => {
      queryClient.setQueryData(["workflows", "instance", instanceId], updated);
    },
  });

  if (instance.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading instance…</p>;
  }

  if (instance.isError || !instance.data) {
    return (
      <ErrorBox
        error={instance.error}
        notFound={
          instance.error instanceof ApiClientError &&
          instance.error.status === 404
        }
      />
    );
  }

  const data = instance.data;
  const inFlight = data.status === "RUNNING" || data.status === "WAITING";
  const overdueCount = data.tasks.filter((t) => isTaskOverdue(t)).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.definitionName}
          </h1>
          <p className="text-sm text-muted-foreground">
            <code className="font-mono">{data.definitionKey}</code> · instance{" "}
            {data.id}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge kind="instance" status={data.status} />
          {inFlight ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null}
        </div>
      </header>

      {cancel.isError ? <ErrorBox error={cancel.error} /> : null}

      <section className="grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm sm:grid-cols-2">
        <Field label="Current step" value={data.currentStepId ?? "—"} />
        <Field
          label="Subject"
          value={
            data.subjectId
              ? `${data.subjectType ?? "subject"}: ${data.subjectId}`
              : "—"
          }
        />
        <Field
          label="Started"
          value={new Date(data.startedAt).toLocaleString()}
        />
        <Field
          label="Completed"
          value={
            data.completedAt
              ? new Date(data.completedAt).toLocaleString()
              : "—"
          }
        />
      </section>

      {overdueCount > 0 ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {overdueCount} task{overdueCount === 1 ? " is" : "s are"} overdue. The
          worker tick will escalate per the step SLA.
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Task timeline</h2>
          {inFlight ? (
            <span className="text-xs text-muted-foreground">
              Auto-refreshing…
            </span>
          ) : null}
        </div>
        <TaskTimeline tasks={data.tasks} />
      </section>

      <ContextBlock context={data.context} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{value}</dd>
    </div>
  );
}

/**
 * The instance `context` is the JSON state the SAFE branch comparator reads
 * (field/op/value). Shown read-only for transparency into why a branch was taken.
 */
function ContextBlock({ context }: { context: Record<string, unknown> }) {
  const keys = Object.keys(context);
  if (keys.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Instance context</h2>
      <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-3 text-xs">
        {JSON.stringify(context, null, 2)}
      </pre>
    </section>
  );
}

function ErrorBox({
  error,
  notFound,
}: {
  error: Error | null;
  notFound?: boolean;
}) {
  if (notFound) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        This workflow instance was not found in your organisation.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {error instanceof ApiClientError
        ? `${error.code}: ${error.message}`
        : "Could not load this workflow instance. Is the API running on NEXT_PUBLIC_API_URL?"}
    </div>
  );
}
