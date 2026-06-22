"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { MatchBar } from "@/components/mobility/match-bar";
import { ReadinessBadge, READINESS_RANK } from "@/components/mobility/readiness-badge";
import { SkillGapChips } from "@/components/mobility/skill-gap-chips";
import { RiskTierBadge } from "@/components/attrition/risk-tier-badge";
import type { InternalCandidate } from "@peopleos/schemas";

/**
 * InternalCandidateList — the ranked internal candidates for an open role (8b,
 * recruiter / HRBP view).
 *
 * Each row shows the candidate's `matchScore` (skill coverage), the readiness
 * badge, the matched / missing skill breakdown + gap size, and — GOVERNANCE — a
 * flight-risk badge ONLY when the API provides `flightRisk`. That field is the
 * Module 7 attrition TIER (never the raw score) and the API returns it non-null
 * ONLY for ADMIN / HRBP viewers; for everyone else it is null and no badge is
 * shown. This component never derives risk; it only renders the supplied tier.
 *
 * Ranking is authoritative server-side (best-first); this list preserves that
 * order and only falls back to a stable readiness → matchScore sort if needed.
 */
export function InternalCandidateList({
  candidates,
  className,
}: {
  candidates: readonly InternalCandidate[];
  className?: string;
}) {
  const ordered = React.useMemo(
    () =>
      [...candidates].sort((a, b) => {
        const byReadiness =
          READINESS_RANK[a.readiness] - READINESS_RANK[b.readiness];
        return byReadiness !== 0 ? byReadiness : b.matchScore - a.matchScore;
      }),
    [candidates],
  );

  if (ordered.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No internal candidates with meaningful skill coverage for this role yet.
      </p>
    );
  }

  return (
    <ol className={cn("space-y-3", className)}>
      {ordered.map((c, index) => (
        <li key={c.employeeId} className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-sm font-semibold tabular-nums text-muted-foreground">
                #{index + 1}
              </span>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">
                    {c.employeeName ?? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {c.employeeId.slice(0, 8)}…
                      </span>
                    )}
                  </p>
                  <ReadinessBadge readiness={c.readiness} />
                  {/* GOVERNANCE: only render when the API supplies the tier
                      (non-null ⇒ ADMIN / HRBP viewer); never the raw score. */}
                  {c.flightRisk ? <RiskTierBadge tier={c.flightRisk} /> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {[c.department, c.level].filter(Boolean).join(" · ") || "—"}
                  {" · "}
                  <span className="text-foreground">
                    {c.gapSize} skill{c.gapSize === 1 ? "" : "s"} to close
                  </span>
                </p>
              </div>
            </div>
            <div className="w-40 shrink-0">
              <MatchBar value={c.matchScore} />
            </div>
          </div>

          <SkillGapChips
            matched={c.matchedSkills}
            missing={c.missingSkills}
            className="mt-3 border-t pt-3"
          />
        </li>
      ))}
    </ol>
  );
}
