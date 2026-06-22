import Link from "next/link";
import { notFound } from "next/navigation";

import { InternalCandidateList } from "@/components/mobility/internal-candidate-list";
import { SuccessionView } from "@/components/mobility/succession-view";
import { api, ApiClientError } from "@/lib/api";
import type { RoleMatchResult, SuccessionPlan } from "@peopleos/schemas";

export const dynamic = "force-dynamic";

/**
 * Module 8b + 8d — "Who internally could fill this role?" (recruiter / HRBP).
 *
 * Server Component: fetches the ranked internal candidates
 * (`api.getInternalCandidates` → `RoleMatchResult`) and the succession plan
 * (`api.getSuccession` → `SuccessionPlan`) for the role, then renders both.
 *
 * Matching is skill-graph driven server-side. GOVERNANCE: each candidate /
 * successor carries `flightRisk` (the Module 7 attrition TIER, never the raw
 * score) only when the viewer is ADMIN / HRBP — it is null otherwise, and the
 * list components show the badge only when it is present. The role-gating is
 * enforced by the API; the UI simply renders what it receives.
 */
export default async function InternalCandidatesPage({
  params,
}: {
  params: { id: string };
}) {
  let candidates: RoleMatchResult;
  let succession: SuccessionPlan;

  try {
    [candidates, succession] = await Promise.all([
      api.getInternalCandidates(params.id),
      api.getSuccession(params.id),
    ]);
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) notFound();
    return (
      <div className="space-y-4">
        <BackLink jobId={params.id} />
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {err instanceof ApiClientError
            ? `${err.code}: ${err.message}`
            : "Failed to load internal candidates. Is the API running on NEXT_PUBLIC_API_URL?"}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <BackLink jobId={params.id} />

      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Internal candidates · {candidates.title}
        </h1>
        <p className="text-sm text-muted-foreground">
          Employees ranked by skill-graph match. Readiness and flight-risk are{" "}
          <span className="font-medium">advisory</span> — you decide who advances.
          Flight-risk (attrition tier) is shown to HR / admin only.
        </p>
        {candidates.requiredSkills.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Required
            </span>
            {candidates.requiredSkills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center rounded-full border border-input bg-card px-2 py-0.5 text-xs"
              >
                {skill}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Top internal candidates</h2>
        <InternalCandidateList candidates={candidates.candidates} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Succession plan</h2>
        <p className="text-sm text-muted-foreground">
          Bench depth for this role — ready now, ready soon, and stretch. A role
          with no internal successors is a talent-pipeline gap.
        </p>
        <SuccessionView plan={succession} />
      </section>
    </div>
  );
}

function BackLink({ jobId }: { jobId: string }) {
  return (
    <Link
      href={`/jobs/${jobId}`}
      className="text-sm text-muted-foreground hover:text-foreground"
    >
      ← Back to job
    </Link>
  );
}
