import * as React from "react";

import { cn } from "@/lib/utils";
import type { InclusiveFlag, InclusiveLanguageReport } from "@peopleos/schemas";

/**
 * InclusiveFlagList — renders the JD Writer's inclusive-language report
 * (Module 2a: "flag gendered words, exclusionary phrases → suggest
 * alternatives"). Each flag is shown as `phrase → suggestion`, grouped by
 * category, plus the bias-check summary (prompt standard #4).
 *
 * Typed off the frozen `InclusiveLanguageReport` contract — no local shapes.
 */

const CATEGORY_LABEL: Record<InclusiveFlag["category"], string> = {
  GENDERED: "Gendered",
  EXCLUSIONARY: "Exclusionary",
  AGE: "Age",
  JARGON: "Jargon",
  ABLEIST: "Ableist",
  OTHER: "Other",
};

/** Stable display order for the categories. */
const CATEGORY_ORDER: ReadonlyArray<InclusiveFlag["category"]> = [
  "GENDERED",
  "EXCLUSIONARY",
  "AGE",
  "ABLEIST",
  "JARGON",
  "OTHER",
];

export function InclusiveFlagList({
  report,
  className,
}: {
  report: InclusiveLanguageReport;
  className?: string;
}) {
  const { flagged, biasCheck } = report;

  const byCategory = React.useMemo(() => {
    const map = new Map<InclusiveFlag["category"], InclusiveFlag[]>();
    for (const flag of flagged) {
      const list = map.get(flag.category) ?? [];
      list.push(flag);
      map.set(flag.category, list);
    }
    return map;
  }, [flagged]);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Inclusive-language check</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {flagged.length} flag{flagged.length === 1 ? "" : "s"}
        </span>
      </div>

      {flagged.length === 0 ? (
        <p className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-xs text-green-700">
          No exclusionary or gendered phrasing detected.
        </p>
      ) : (
        <ul className="space-y-3">
          {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => (
            <li key={category} className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABEL[category]}
              </p>
              <ul className="space-y-1.5">
                {byCategory.get(category)!.map((flag, i) => (
                  <li
                    key={`${category}-${i}`}
                    className="rounded-md border bg-muted/40 px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-destructive line-through decoration-destructive/50">
                      {flag.phrase}
                    </span>
                    <span aria-hidden className="mx-1.5 text-muted-foreground">
                      →
                    </span>
                    <span className="font-medium text-green-700">{flag.suggestion}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {/* Bias-check envelope (prompt standard #4) attached to every HR-facing gen. */}
      <BiasCheckNote
        biasIndicatorsDetected={biasCheck.biasIndicatorsDetected}
        correctionApplied={biasCheck.correctionApplied}
      />
    </div>
  );
}

/**
 * BiasCheckNote — compact display of a `BiasCheck` envelope. Shared by the JD
 * Writer (via InclusiveFlagList) and the Outreach panel, both of which carry a
 * bias check per prompt standard #4. Typed off the frozen `BiasCheck` fields.
 */
export function BiasCheckNote({
  biasIndicatorsDetected,
  correctionApplied,
  className,
}: {
  biasIndicatorsDetected: string[];
  correctionApplied: boolean;
  className?: string;
}) {
  const hasIndicators = biasIndicatorsDetected.length > 0;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        hasIndicators
          ? "border-amber-600/40 bg-amber-600/10 text-amber-700"
          : "border-input bg-muted/40 text-muted-foreground",
        className,
      )}
    >
      <p className="font-medium">
        Bias check
        {correctionApplied ? (
          <span className="ml-1 font-normal">· correction applied</span>
        ) : null}
      </p>
      {hasIndicators ? (
        <ul className="ml-4 mt-1 list-disc">
          {biasIndicatorsDetected.map((indicator, i) => (
            <li key={i}>{indicator}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-0.5 font-normal">No bias indicators detected.</p>
      )}
    </div>
  );
}
