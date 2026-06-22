import * as React from "react";

import { cn } from "@/lib/utils";
import type { Readiness } from "@peopleos/schemas";

/**
 * ReadinessBadge — the Module 8 mobility readiness pill (how close an employee is
 * to filling a role, derived server-side from skill coverage).
 *
 * READY_NOW (green) → READY_SOON (blue) → STRETCH (amber). Readiness is derived
 * from the skill graph (coverage + gap size), never the client; this component
 * only visualises the contract value. Like every PeopleOS AI signal it is
 * ADVISORY — a recruiter / HRBP decides who advances.
 */
const READINESS_CLASS: Record<Readiness, string> = {
  READY_NOW: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
  READY_SOON: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  STRETCH: "border-amber-600/40 bg-amber-600/10 text-amber-700",
};

const READINESS_LABEL: Record<Readiness, string> = {
  READY_NOW: "Ready now",
  READY_SOON: "Ready soon",
  STRETCH: "Stretch",
};

/** Readiness ordering for sorting (most ready first). */
export const READINESS_RANK: Record<Readiness, number> = {
  READY_NOW: 0,
  READY_SOON: 1,
  STRETCH: 2,
};

export function ReadinessBadge({
  readiness,
  className,
}: {
  readiness: Readiness;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        READINESS_CLASS[readiness],
        className,
      )}
      title="Mobility readiness (derived from skill coverage — advisory)"
      aria-label={`${READINESS_LABEL[readiness]} for this role (advisory)`}
    >
      {READINESS_LABEL[readiness]}
    </span>
  );
}

export { READINESS_LABEL };
