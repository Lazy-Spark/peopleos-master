"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { MatchBar } from "@/components/mobility/match-bar";
import { ReadinessBadge } from "@/components/mobility/readiness-badge";
import { SkillGapChips } from "@/components/mobility/skill-gap-chips";
import { InternalAppStatusBadge } from "@/components/mobility/internal-app-status-badge";
import { api, ApiClientError } from "@/lib/api";
import type {
  InternalApplicationView,
  JobOpening,
  RecommendedRole,
  RecommendedRoles,
} from "@peopleos/schemas";

/**
 * MobilityBoard (8a, client) — the employee internal job board.
 *
 * Three sections: "Recommended for you" (skill-graph matched roles with apply),
 * "Browse open roles" (the org's openings), and "My internal applications"
 * (status pipeline). Applying acts on the employee's OWN behalf — the API
 * resolves the acting employee from the session; the client only sends the
 * `jobOpeningId` (the frozen `CreateInternalApplicationRequest`). The employee in
 * context is read from `?employee=` in this dev foundation so recommendations can
 * be exercised before Clerk-derived resolution lands.
 */
export function MobilityBoard() {
  const searchParams = useSearchParams();
  const employeeId = searchParams.get("employee") ?? "";

  if (employeeId === "") {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No employee in context. In production you would see your own
        recommendations; in dev, append{" "}
        <code>?employee=&lt;your-employee-id&gt;</code> to load skill-matched
        roles and your applications.
      </p>
    );
  }

  return <BoardForEmployee employeeId={employeeId} />;
}

function BoardForEmployee({ employeeId }: { employeeId: string }) {
  const queryClient = useQueryClient();

  const recommended = useQuery<RecommendedRoles, Error>({
    queryKey: ["mobility", "recommended-roles", employeeId],
    queryFn: () => api.getRecommendedRoles(employeeId),
  });

  const jobs = useQuery<JobOpening[], Error>({
    queryKey: ["jobs", "open"],
    queryFn: () => api.listJobs({ limit: 50 }),
  });

  const applications = useQuery<InternalApplicationView[], Error>({
    queryKey: ["mobility", "internal-applications"],
    queryFn: () => api.listInternalApplications(),
  });

  const apply = useMutation({
    mutationFn: (jobOpeningId: string) => api.applyInternal({ jobOpeningId }),
    onSuccess: () => {
      // Refresh both the recommendations (alreadyApplied flips) and my list.
      void queryClient.invalidateQueries({
        queryKey: ["mobility", "recommended-roles", employeeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["mobility", "internal-applications"],
      });
    },
  });

  // Job ids the employee already has an internal application for — used to gate
  // the browse "Apply" button (the recommendations carry `alreadyApplied` too).
  const appliedJobIds = React.useMemo(
    () => new Set((applications.data ?? []).map((a) => a.jobOpeningId)),
    [applications.data],
  );

  return (
    <div className="space-y-8">
      {/* ── Recommended for you ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Recommended for you</h2>
        {recommended.isLoading ? (
          <p className="text-sm text-muted-foreground">Finding matches…</p>
        ) : recommended.isError || !recommended.data ? (
          <ErrorBox error={recommended.error} what="recommendations" />
        ) : recommended.data.roles.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No matched roles yet. Add more skills to your profile to surface
            internal opportunities.
          </p>
        ) : (
          <ul className="space-y-3">
            {recommended.data.roles.map((role) => (
              <RecommendedRoleRow
                key={role.jobOpeningId}
                role={role}
                employeeId={employeeId}
                onApply={() => apply.mutate(role.jobOpeningId)}
                applying={
                  apply.isPending && apply.variables === role.jobOpeningId
                }
              />
            ))}
          </ul>
        )}
        {apply.isError ? (
          <ErrorBox error={apply.error} what="application" />
        ) : null}
      </section>

      {/* ── Browse open roles ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Browse open roles</h2>
        {jobs.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading open roles…</p>
        ) : jobs.isError || !jobs.data ? (
          <ErrorBox error={jobs.error} what="open roles" />
        ) : jobs.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open roles right now.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {jobs.data.map((job) => {
              const already = appliedJobIds.has(job.id);
              return (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{job.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {[job.department, job.location, job.level]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => apply.mutate(job.id)}
                    disabled={already || apply.isPending}
                  >
                    {already ? "Applied" : "Apply"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── My internal applications ──────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">My internal applications</h2>
        {applications.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading applications…</p>
        ) : applications.isError || !applications.data ? (
          <ErrorBox error={applications.error} what="applications" />
        ) : applications.data.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            You have no internal applications yet.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {applications.data.map((app) => (
              <li
                key={app.id}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{app.jobTitle}</p>
                  <p className="text-xs text-muted-foreground">
                    Applied {new Date(app.createdAt).toLocaleDateString()}
                    {app.matchScore !== null
                      ? ` · ${Math.round(app.matchScore * 100)}% match`
                      : ""}
                  </p>
                </div>
                <InternalAppStatusBadge status={app.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RecommendedRoleRow({
  role,
  employeeId,
  onApply,
  applying,
}: {
  role: RecommendedRole;
  employeeId: string;
  onApply: () => void;
  applying: boolean;
}) {
  return (
    <li className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{role.title}</p>
            <ReadinessBadge readiness={role.readiness} />
          </div>
          <p className="text-xs text-muted-foreground">
            {[role.department, role.level].filter(Boolean).join(" · ") || "—"}
            {" · "}
            <span className="text-foreground">
              {role.gapSize} skill{role.gapSize === 1 ? "" : "s"} to grow into
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-32">
            <MatchBar value={role.matchScore} />
          </div>
          <Button
            size="sm"
            onClick={onApply}
            disabled={role.alreadyApplied || applying}
          >
            {role.alreadyApplied ? "Applied" : applying ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>

      <SkillGapChips
        matched={role.matchedSkills}
        missing={role.missingSkills}
        className="mt-3 border-t pt-3"
      />

      <p className="mt-3 text-xs text-muted-foreground">
        Want a development plan?{" "}
        <Link
          href={`/employees/${employeeId}/skills`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          See your skill gap &amp; growth path →
        </Link>{" "}
        (pick this role as the target).
      </p>
    </li>
  );
}

function ErrorBox({ error, what }: { error: Error | null; what: string }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {error instanceof ApiClientError
        ? `${error.code}: ${error.message}`
        : `Could not load ${what}. Is the API running on NEXT_PUBLIC_API_URL?`}
    </div>
  );
}
