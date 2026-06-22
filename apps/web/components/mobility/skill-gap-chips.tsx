import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SkillGapChips — the matched / missing skill breakdown for a mobility match,
 * rendered as two rows of chips.
 *
 * Matched skills (the required skills the person already holds) read emerald;
 * missing skills (the gap to close) read amber. Both arrays come straight from
 * the frozen contract (`matchedSkills` / `missingSkills`), computed server-side
 * from the Module 6 skill graph — this component only displays them.
 */
export function SkillGapChips({
  matched,
  missing,
  className,
}: {
  matched: readonly string[];
  missing: readonly string[];
  className?: string;
}) {
  if (matched.length === 0 && missing.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)}>
      {matched.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Matched
          </span>
          {matched.map((skill) => (
            <span
              key={`m-${skill}`}
              className="inline-flex items-center rounded-full border border-emerald-600/40 bg-emerald-600/10 px-2 py-0.5 text-xs text-emerald-700"
            >
              {skill}
            </span>
          ))}
        </div>
      ) : null}
      {missing.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Gap
          </span>
          {missing.map((skill) => (
            <span
              key={`g-${skill}`}
              className="inline-flex items-center rounded-full border border-amber-600/40 bg-amber-600/10 px-2 py-0.5 text-xs text-amber-700"
            >
              {skill}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
