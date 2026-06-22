"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import * as React from "react";

import {
  INSTANCE_LABEL,
  INSTANCE_STATUS_ORDER,
  StatusBadge,
} from "@/components/workflows/status-badge";
import { api, ApiClientError } from "@/lib/api";
import type { InstanceStatus, WorkflowMonitor } from "@peopleos/schemas";

/**
 * MonitorDashboard (Module 9, client) — the org workflow monitor (ADMIN / HRBP).
 *
 * Reads `WorkflowMonitor`: instances grouped `byStatus` (rendered as count
 * tiles), the org-wide `overdueTasks` count (highlighted when non-zero), and the
 * `recentInstances` summaries (each linking to its monitor). The view is
 * role-gated server-side; a 403 renders an access notice rather than an error.
 * Refetches on an interval so the operations view stays current.
 */
export function MonitorDashboard() {
  const monitor = useQuery<WorkflowMonitor, Error>({
    queryKey: ["workflows", "monitor"],
    queryFn: () => api.getWorkflowMonitor(),
    refetchInterval: 15_000,
  });

  if (monitor.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading monitor…</p>;
  }

  if (monitor.isError || !monitor.data) {
    const forbidden =
      monitor.error instanceof ApiClientError && monitor.error.status === 403;
    if (forbidden) {
      return (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          The workflow monitor is available to ADMIN and HRBP roles only.
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {monitor.error instanceof ApiClientError
          ? `${monitor.error.code}: ${monitor.error.message}`
          : "Could not load the monitor. Is the API running on NEXT_PUBLIC_API_URL?"}
      </div>
    );
  }

  const data = monitor.data;
  const byStatus = [...data.byStatus].sort(
    (a, b) => INSTANCE_STATUS_ORDER[a.status] - INSTANCE_STATUS_ORDER[b.status],
  );
  const total = byStatus.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Instances by status</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {(Object.keys(INSTANCE_LABEL) as InstanceStatus[]).map((status) => {
            const count =
              byStatus.find((s) => s.status === status)?.count ?? 0;
            return (
              <div key={status} className="rounded-lg border p-4">
                <p className="text-2xl font-semibold tabular-nums">{count}</p>
                <div className="mt-1">
                  <StatusBadge kind="instance" status={status} />
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{total} total instances.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Overdue tasks</h2>
        <div
          className={
            data.overdueTasks > 0
              ? "rounded-lg border border-destructive/40 bg-destructive/5 p-4"
              : "rounded-lg border p-4"
          }
        >
          <p
            className={
              data.overdueTasks > 0
                ? "text-2xl font-semibold tabular-nums text-destructive"
                : "text-2xl font-semibold tabular-nums"
            }
          >
            {data.overdueTasks}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            human task{data.overdueTasks === 1 ? "" : "s"} past their SLA — the
            worker tick escalates these.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Recent instances</h2>
        {data.recentInstances.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No workflow instances yet.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {data.recentInstances.map((inst) => (
              <li
                key={inst.id}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <Link
                    href={`/workflows/${inst.id}`}
                    className="font-medium hover:underline"
                  >
                    {inst.definitionName}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    <code className="font-mono">{inst.definitionKey}</code>
                    {inst.currentStepId ? ` · at ${inst.currentStepId}` : ""} ·
                    started {new Date(inst.startedAt).toLocaleString()}
                  </p>
                </div>
                <StatusBadge kind="instance" status={inst.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
