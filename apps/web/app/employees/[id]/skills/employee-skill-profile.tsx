"use client";

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { AddSkillControl } from "@/components/skills/add-skill-control";
import { GrowthPathPanel } from "@/components/skills/growth-path-panel";
import { SkillBadge } from "@/components/skills/skill-badge";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  confidencePct,
  PROFICIENCY_RANK,
  SOURCE_LABEL,
} from "@/components/skills/skill-display";
import { VerifySkillButton } from "@/components/skills/verify-skill-button";
import { api, ApiClientError } from "@/lib/api";
import type {
  EmployeeSkillProfile as EmployeeSkillProfileT,
  JobOpening,
  SkillCategory,
  SkillRecordView,
} from "@peopleos/schemas";

/**
 * EmployeeSkillProfile (Module 6a, client) — the employee's skill map grouped by
 * category, each skill rendered as a `SkillBadge` whose confidence dot is sized +
 * coloured by the source-derived `confidenceScore` (spec: "sized by proficiency
 * confidence"). Includes the self-report "add skill" control and the AI
 * growth-path panel (target role → stepsAway + recommendedSkills + training).
 *
 * Verification (6d) is offered per unverified record to viewers who can verify
 * (ADMIN / HRBP / MANAGER); the API enforces this server-side. `canVerify` is the
 * UI hint that decides whether to render the control at all.
 *
 * Wire shapes are `@peopleos/schemas`; reads go through TanStack Query so a
 * self-report / verification can invalidate and re-render.
 */
export function EmployeeSkillProfile({
  employeeId,
  roles,
  canVerify,
}: {
  employeeId: string;
  /** Open roles for the growth-path target picker (`api.listJobs`). */
  roles: JobOpening[];
  /** Whether to show the manager Verify control (6d); API is the real boundary. */
  canVerify: boolean;
}) {
  const profile = useQuery<EmployeeSkillProfileT, Error>({
    queryKey: ["skills", "profile", employeeId],
    queryFn: () => api.getEmployeeSkills(employeeId),
  });

  if (profile.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading skills…</p>;
  }

  if (profile.isError || !profile.data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {profile.error instanceof ApiClientError
          ? `${profile.error.code}: ${profile.error.message}`
          : "Could not load this employee's skills. Is the API running on NEXT_PUBLIC_API_URL?"}
      </div>
    );
  }

  const data = profile.data;
  const ownedSkillIds = data.skills.map((s) => s.skillId);

  // Group records by category, ordered by the canonical category order, and sort
  // each group strongest-first (proficiency, then confidence).
  const grouped = groupByCategory(data.skills);
  const invalidateKeys = [["skills", "profile", employeeId]] as const;

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {data.employeeName ?? "Employee"} · Skills
        </h1>
        <p className="text-sm text-muted-foreground">
          {data.skills.length} skill{data.skills.length === 1 ? "" : "s"} across{" "}
          {grouped.length} categor{grouped.length === 1 ? "y" : "ies"}. The dot
          beside each skill encodes confidence — bigger and greener means more
          strongly verified.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Skill map</h2>
          <AddSkillControl employeeId={employeeId} ownedSkillIds={ownedSkillIds} />
        </div>

        {data.skills.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No skills recorded yet. Add one above, or skills will populate from
            resume parsing, training completions, and manager assessments.
          </p>
        ) : (
          <div className="space-y-6">
            {grouped.map(({ category, records }) => (
              <div key={category} className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {CATEGORY_LABEL[category]}
                </h3>
                <ul className="space-y-2">
                  {records.map((rec) => (
                    <li
                      key={rec.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-2.5"
                    >
                      <SkillBadge
                        name={rec.skillName}
                        proficiency={rec.proficiency}
                        confidenceScore={rec.confidenceScore}
                        source={rec.source}
                      />
                      <div className="flex items-center gap-3">
                        <span
                          className="text-xs text-muted-foreground"
                          title={SOURCE_LABEL[rec.source]}
                        >
                          {SOURCE_LABEL[rec.source]} ·{" "}
                          {confidencePct(rec.confidenceScore)}
                        </span>
                        <VerifySkillButton
                          record={rec}
                          canVerify={canVerify}
                          invalidateKeys={invalidateKeys}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <GrowthPathPanel employeeId={employeeId} roles={roles} />
    </div>
  );
}

/** Group + sort records by the canonical category order (empty groups dropped). */
function groupByCategory(
  records: SkillRecordView[],
): Array<{ category: SkillCategory; records: SkillRecordView[] }> {
  const byCat = new Map<SkillCategory, SkillRecordView[]>();
  for (const rec of records) {
    const list = byCat.get(rec.category) ?? [];
    list.push(rec);
    byCat.set(rec.category, list);
  }
  return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((category) => {
    const list = byCat.get(category)!;
    list.sort((a, b) => {
      const byProf = PROFICIENCY_RANK[b.proficiency] - PROFICIENCY_RANK[a.proficiency];
      return byProf !== 0 ? byProf : b.confidenceScore - a.confidenceScore;
    });
    return { category, records: list };
  });
}
