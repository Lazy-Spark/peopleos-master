import Link from "next/link";
import { notFound } from "next/navigation";

import { ChatSidebar } from "@/components/copilot/chat-sidebar";
import { api, ApiClientError, type PipelineEntry } from "@/lib/api";
import type { JobOpening } from "@peopleos/schemas";

import { PipelineList } from "./pipeline-list";

export const dynamic = "force-dynamic";

/**
 * Job detail (Server Component): fetches the job + its candidate pipeline, then
 * hands the pipeline to a client component that owns the "Screen all" batch
 * ranking mutation (POST /api/v1/jobs/:id/rank) and renders the ranked recruiter
 * shortlist — tier, score, sub-score breakdown, and explainability per candidate.
 */
export default async function JobDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let job: JobOpening;
  let pipeline: PipelineEntry[] = [];

  try {
    [job, pipeline] = await Promise.all([
      api.getJob(params.id),
      api.listJobApplications(params.id),
    ]);
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) notFound();
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {err instanceof ApiClientError
            ? `${err.code}: ${err.message}`
            : "Failed to load job. Is the API running on NEXT_PUBLIC_API_URL?"}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{job.title}</h1>
        <p className="text-sm text-muted-foreground">
          {[job.department, job.location, job.level, job.type]
            .filter(Boolean)
            .join(" · ") || "—"}
        </p>
      </div>

      {/* Pipeline shortlist (Module 1 + 2b outreach) alongside the Copilot chat
          sidebar (Module 2c), which is scoped to this job for pipeline context. */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Recruiter shortlist</h2>
          <p className="text-sm text-muted-foreground">
            Candidates ranked best-first by Module 1. Tiers and scores are{" "}
            <span className="font-medium">advisory</span> — you decide who advances.
          </p>
          <PipelineList jobId={job.id} initialEntries={pipeline} />
        </section>

        <ChatSidebar jobId={job.id} jobTitle={job.title} className="lg:sticky lg:top-8 lg:self-start" />
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
      ← Back to jobs
    </Link>
  );
}
