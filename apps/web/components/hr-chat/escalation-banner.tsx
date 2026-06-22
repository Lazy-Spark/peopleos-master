import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * EscalationBanner — shown beneath an assistant answer that has been escalated
 * to a human HR Business Partner (Module 4 RAG step 5).
 *
 * Escalation is triggered by low confidence, repeated failed queries, or a
 * SENSITIVE topic (termination, harassment, salary dispute) — sensitive topics
 * are always handed to a person rather than answered from policy text. When the
 * API opens an HR ticket it returns the `ticketId`; we surface it so the
 * employee knows a human will follow up and can reference the ticket.
 *
 * Presentational only — typed off plain props derived from `AskResponse`
 * (`escalated`, `ticketId`) by the caller; no wire shape is redeclared here.
 */
export function EscalationBanner({
  ticketId,
  className,
}: {
  /** The HR ticket the API opened on escalation; null if none was created. */
  ticketId: string | null;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-2 text-xs text-amber-800",
        className,
      )}
    >
      <p className="font-medium">Connecting you with a human</p>
      <p className="mt-0.5 leading-relaxed">
        This question is best handled by an HR Business Partner, so I&apos;ve passed
        it to a person on the People team. They&apos;ll follow up with you directly.
      </p>
      {ticketId ? (
        <p className="mt-1.5">
          HR ticket opened:{" "}
          <code className="rounded bg-amber-600/15 px-1 py-0.5 font-mono text-[11px] text-amber-900">
            {ticketId}
          </code>
        </p>
      ) : null}
    </div>
  );
}
