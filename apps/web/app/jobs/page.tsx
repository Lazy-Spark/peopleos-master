import Link from "next/link";

import { api, ApiClientError } from "@/lib/api";
import type { JobOpening } from "@peopleos/schemas";

export const dynamic = "force-dynamic";

/**
 * Jobs list (Server Component). Lists the current org's job openings via the
 * typed API client. Each row links to the per-job candidate pipeline.
 */
export default async function JobsPage() {
  let jobs: JobOpening[] = [];
  let error: string | null = null;

  try {
    jobs = await api.listJobs({ limit: 50 });
  } catch (err) {
    error =
      err instanceof ApiClientError
        ? `${err.code}: ${err.message}`
        : "Failed to load jobs. Is the API running on NEXT_PUBLIC_API_URL?";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <span className="text-sm text-muted-foreground">
          {jobs.length} open role{jobs.length === 1 ? "" : "s"}
        </span>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No jobs yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {jobs.map((job) => (
            <li key={job.id}>
              <Link
                href={`/jobs/${job.id}`}
                className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-accent"
              >
                <div className="space-y-0.5">
                  <p className="font-medium">{job.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {[job.department, job.location, job.level]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                </div>
                <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                  {job.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
