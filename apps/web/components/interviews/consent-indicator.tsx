import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * ConsentIndicator — a compact badge confirming candidate consent to record +
 * process the interview (Module 3 privacy: "candidate consent required before
 * recording + processing").
 *
 * Consent is a structural precondition in the contract: the frozen
 * `CreateInterviewRequest.consentObtained` is `z.literal(true)`, so an interview
 * cannot exist without it. This indicator makes that guarantee visible to the
 * reviewer; `obtained` defaults to true accordingly, with a not-on-file state
 * kept for completeness / defence in depth.
 *
 * Purely presentational — no wire shape is declared here.
 */
export function ConsentIndicator({
  obtained = true,
  className,
}: {
  obtained?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        obtained
          ? "border-green-600/40 bg-green-600/10 text-green-700"
          : "border-destructive/50 bg-destructive/10 text-destructive",
        className,
      )}
      title={
        obtained
          ? "Candidate consented to recording + processing"
          : "No consent on file — processing must not proceed"
      }
    >
      <span aria-hidden>{obtained ? "✓" : "!"}</span>
      {obtained ? "Consent on file" : "Consent missing"}
    </span>
  );
}
