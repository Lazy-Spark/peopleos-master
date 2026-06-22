"use client";

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { ScoreBar } from "@/components/ui/score-bar";
import { api, ApiClientError, type SkillGapWithGrowth } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Confidence, JobOpening } from "@peopleos/schemas";

/**
 * GrowthPathPanel — Module 6a "AI growth path suggestions". The employee picks a
 * target role (a `JobOpening`, whose `jdStructured.requiredSkills` are the bar);
 * the panel fetches `api.getSkillGap` which returns BOTH the API-computed
 * `SkillGapReport` (matched / missing / coverage) AND the AI `GrowthPathResponse`
 * ("You are N skills away … add X and Y"): `stepsAway`, `recommendedSkills`
 * (each with a `why` rationale + an optional `suggestedTraining`).
 *
 * The AI output is advisory and grounded only in the supplied gap (prompt
 * standards): we surface its `confidence` and any `biasCheck` indicators. All
 * wire shapes come from `@peopleos/schemas`.
 */

const CONFIDENCE_PILL: Record<Confidence, string> = {
  low: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  medium: "border-yellow-600/40 bg-yellow-600/10 text-yellow-700",
  high: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
};

export function GrowthPathPanel({
  employeeId,
  roles,
}: {
  employeeId: string;
  /** Open roles to target (from `api.listJobs`); the user picks one. */
  roles: JobOpening[];
}) {
  const [targetRoleId, setTargetRoleId] = React.useState<string>("");

  const gap = useQuery<SkillGapWithGrowth, Error>({
    queryKey: ["skills", "gap", employeeId, targetRoleId],
    queryFn: () => api.getSkillGap(employeeId, targetRoleId),
    enabled: targetRoleId !== "",
  });

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Growth path</h2>
        <p className="text-sm text-muted-foreground">
          Pick a target role to see how far you are from its skill bar and which
          skills to add next. Suggestions are AI-generated and advisory.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="target-role" className="text-sm font-medium">
          Target role
        </label>
        <select
          id="target-role"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          value={targetRoleId}
          onChange={(e) => setTargetRoleId(e.target.value)}
        >
          <option value="">Select a role…</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
              {r.department ? ` · ${r.department}` : ""}
            </option>
          ))}
        </select>
      </div>

      {targetRoleId === "" ? null : gap.isLoading ? (
        <p className="text-sm text-muted-foreground">Computing your growth path…</p>
      ) : gap.isError || !gap.data ? (
        <p className="text-sm text-destructive">
          {gap.error instanceof ApiClientError
            ? `${gap.error.code}: ${gap.error.message}`
            : "Could not compute the growth path."}
        </p>
      ) : (
        <GrowthPathResult data={gap.data} />
      )}
    </section>
  );
}

function GrowthPathResult({ data }: { data: SkillGapWithGrowth }) {
  const { gap, growthPath } = data;

  return (
    <div className="space-y-5">
      {/* Headline: steps away + coverage (the spec's "2 skills away" framing). */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-4">
        <div>
          <p className="text-2xl font-semibold tabular-nums">
            {growthPath.stepsAway}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              skill{growthPath.stepsAway === 1 ? "" : "s"} away
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            from {gap.targetRoleTitle}
          </p>
        </div>
        <div className="w-40">
          <ScoreBar label="Coverage" value={gap.coverage} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {gap.matched.length} of {gap.requiredSkills.length} required skills
          </p>
        </div>
      </div>

      <p className="text-sm text-foreground">{growthPath.summary}</p>

      {/* Recommended skills with rationale + suggested training (6a). */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Recommended skills to add</h3>
        {growthPath.recommendedSkills.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You already meet this role&apos;s skill bar. Nothing to add.
          </p>
        ) : (
          <ul className="space-y-2">
            {growthPath.recommendedSkills.map((rec) => (
              <li
                key={rec.skill}
                className="space-y-1 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {rec.skill}
                  </span>
                  {rec.suggestedTraining ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      Training: {rec.suggestedTraining}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{rec.why}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Still-missing skills (API-computed gap, ground truth for the AI). */}
      {gap.missing.length > 0 ? (
        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Missing required skills
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {gap.missing.map((s) => (
              <span
                key={s}
                className="rounded-full border border-amber-600/40 bg-amber-600/10 px-2 py-0.5 text-xs text-amber-700"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* AI provenance: confidence + bias check (advisory, never autonomous). */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 font-medium uppercase tracking-wide",
            CONFIDENCE_PILL[growthPath.confidence],
          )}
        >
          {growthPath.confidence} confidence
        </span>
        <span>AI-advisory · {growthPath.modelVersion}</span>
        {growthPath.biasCheck.biasIndicatorsDetected.length > 0 ? (
          <span className="text-amber-700">
            Bias check: {growthPath.biasCheck.biasIndicatorsDetected.join(", ")}
            {growthPath.biasCheck.correctionApplied ? " (corrected)" : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}
