import * as React from "react";

import { cn } from "@/lib/utils";
import type { Citation } from "@peopleos/schemas";

/**
 * CitationList — renders the source citations attached to a grounded HR Assistant
 * answer (Module 4 RAG step 4). RAG faithfulness is central: every claim the
 * assistant makes is backed by a policy chunk, so each citation surfaces the
 * policy title + section path + effective date, plus a "View full policy"
 * affordance (a deep link to the document in the knowledge base).
 *
 * Typed off the frozen `Citation` contract — no locally-redeclared wire shapes.
 * An empty list renders nothing (a grounded answer always carries citations; a
 * "not in policy" / escalation answer legitimately has none).
 */
export function CitationList({
  citations,
  className,
}: {
  citations: Citation[];
  className?: string;
}) {
  if (citations.length === 0) return null;

  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Sources · company policy
      </p>
      <ul className="space-y-1.5">
        {citations.map((citation, i) => (
          <CitationItem key={`${citation.docId}-${citation.sectionPath}-${i}`} citation={citation} />
        ))}
      </ul>
    </div>
  );
}

function CitationItem({ citation }: { citation: Citation }) {
  return (
    <li className="rounded-md border bg-background px-2.5 py-1.5 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="min-w-0">
          <span className="font-medium text-foreground">{citation.docTitle}</span>
          {citation.sectionPath ? (
            <span className="text-muted-foreground"> · {citation.sectionPath}</span>
          ) : null}
        </span>
        {/* Deep link to the full policy document in the knowledge base. The API
            owns the canonical route; we link by docId so it resolves to the
            stored PolicyDocument regardless of version. */}
        <a
          href={`/policies/${citation.docId}`}
          className="shrink-0 font-medium text-primary underline-offset-4 hover:underline"
        >
          View full policy →
        </a>
      </div>
      {citation.effectiveDate ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Effective {citation.effectiveDate}
        </p>
      ) : (
        <p className="mt-0.5 text-[10px] text-muted-foreground">Effective date not set</p>
      )}
    </li>
  );
}
