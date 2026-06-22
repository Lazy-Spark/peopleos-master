import * as React from "react";

import { cn } from "@/lib/utils";
import {
  confidencePct,
  PROFICIENCY_LABEL,
  PROFICIENCY_RANK,
} from "@/components/skills/skill-display";
import type { ProficiencyLevel, TeamSkillMap } from "@peopleos/schemas";

/**
 * SkillHeatmap — Module 6b team grid: members (rows) × skills (columns), each
 * cell shaded by proficiency (intensity) and labelled with the confidence on
 * hover. Bus-factor columns (a skill held by exactly one report — `busFactor`
 * from the contract) are highlighted; the per-skill bench strength (holder count)
 * is shown in the column header. All values come from `TeamSkillMap`; this is
 * presentational only.
 *
 * Skill columns are derived from the union of members' skills, ordered by bench
 * strength then name, so the strongest coverage reads left-to-right and the
 * single-holder (bus-factor) skills stand out.
 */

/** Proficiency → cell tint (AWARE faint → EXPERT solid). */
const CELL_FILL: Record<ProficiencyLevel, string> = {
  AWARE: "bg-primary/15 text-foreground",
  PRACTITIONER: "bg-primary/35 text-foreground",
  ADVANCED: "bg-primary/60 text-primary-foreground",
  EXPERT: "bg-primary text-primary-foreground",
};

type Cell = { proficiency: ProficiencyLevel; confidenceScore: number };

export function SkillHeatmap({ map }: { map: TeamSkillMap }) {
  const benchById = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const b of map.benchStrength) m.set(b.skillName, b.count);
    return m;
  }, [map.benchStrength]);

  const busFactorNames = React.useMemo(
    () => new Set(map.busFactor.map((b) => b.skillName)),
    [map.busFactor],
  );

  // Column set = union of every member's skill names.
  const skillNames = React.useMemo(() => {
    const set = new Set<string>();
    for (const member of map.members) {
      for (const s of member.skills) set.add(s.skillName);
    }
    // Strongest bench first, then alphabetical for stability.
    return [...set].sort((a, b) => {
      const byBench = (benchById.get(b) ?? 0) - (benchById.get(a) ?? 0);
      return byBench !== 0 ? byBench : a.localeCompare(b);
    });
  }, [map.members, benchById]);

  // Per-member lookup of skillName → cell, so the grid renders in O(rows × cols).
  const cellByMember = React.useMemo(() => {
    const rows = new Map<string, Map<string, Cell>>();
    for (const member of map.members) {
      const byName = new Map<string, Cell>();
      for (const s of member.skills) {
        byName.set(s.skillName, {
          proficiency: s.proficiency,
          confidenceScore: s.confidenceScore,
        });
      }
      rows.set(member.employeeId, byName);
    }
    return rows;
  }, [map.members]);

  if (map.members.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This manager has no direct reports with recorded skills yet.
      </p>
    );
  }

  if (skillNames.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No skills recorded for this team yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-muted/40">
            <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Member
            </th>
            {skillNames.map((name) => {
              const isBusFactor = busFactorNames.has(name);
              const bench = benchById.get(name) ?? 0;
              return (
                <th
                  key={name}
                  className={cn(
                    "px-2 py-2 text-center align-bottom text-xs font-medium",
                    isBusFactor
                      ? "bg-destructive/10 text-destructive"
                      : "text-muted-foreground",
                  )}
                  title={
                    isBusFactor
                      ? `Bus-factor risk — only ${bench} holder`
                      : `${bench} holders`
                  }
                >
                  <span className="block max-w-[7rem] truncate">{name}</span>
                  <span className="mt-0.5 block text-[10px] font-normal tabular-nums">
                    {isBusFactor ? "⚠ 1" : bench}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y">
          {map.members.map((member) => {
            const byName = cellByMember.get(member.employeeId);
            return (
              <tr key={member.employeeId}>
                <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
                  {member.employeeName ?? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {member.employeeId.slice(0, 8)}…
                    </span>
                  )}
                </td>
                {skillNames.map((name) => {
                  const cell = byName?.get(name);
                  if (!cell) {
                    return (
                      <td
                        key={name}
                        className="px-2 py-2 text-center text-muted-foreground/30"
                        aria-label={`No ${name}`}
                      >
                        ·
                      </td>
                    );
                  }
                  return (
                    <td key={name} className="px-1.5 py-1.5 text-center">
                      <span
                        className={cn(
                          "inline-flex h-7 min-w-[2.75rem] items-center justify-center rounded text-[11px] font-medium tabular-nums",
                          CELL_FILL[cell.proficiency],
                        )}
                        title={`${PROFICIENCY_LABEL[cell.proficiency]} · ${confidencePct(
                          cell.confidenceScore,
                        )} confidence`}
                        aria-label={`${name}: ${PROFICIENCY_LABEL[cell.proficiency]}, ${confidencePct(
                          cell.confidenceScore,
                        )} confidence`}
                      >
                        {PROFICIENCY_RANK[cell.proficiency]}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
