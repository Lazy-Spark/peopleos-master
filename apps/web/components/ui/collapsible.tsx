import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Collapsible — a minimal disclosure built on the native <details>/<summary>
 * element (no extra dependency, keyboard-accessible by default). Used for the
 * recruiter shortlist's expandable explainability sections (strengths /
 * concerns / interview focus).
 */
export function Collapsible({
  summary,
  count,
  defaultOpen = false,
  className,
  children,
}: {
  summary: string;
  /** Optional item count rendered next to the summary label. */
  count?: number;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <details className={cn("group", className)} open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-foreground marker:content-none">
        <span
          aria-hidden
          className="inline-block text-muted-foreground transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        <span>{summary}</span>
        {typeof count === "number" ? (
          <span className="text-muted-foreground">({count})</span>
        ) : null}
      </summary>
      <div className="mt-1.5 pl-4">{children}</div>
    </details>
  );
}
