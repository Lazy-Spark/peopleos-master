import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * PendingSection — the graceful-degradation placeholder for dashboard sections
 * whose data source is not yet built (Module 5c Engagement → unlocks with the
 * Module 7 attrition engine; Module 5d Skills → unlocks with the Module 6 skill
 * graph). The frozen contracts return `available: false` + a `pendingReason`
 * for these; the dashboard renders this instead of erroring.
 *
 * Purely presentational: it surfaces the `unlocksWith` module and the
 * server-supplied `pendingReason` so the user understands why the section is dark
 * and what lights it up.
 */
export function PendingSection({
  unlocksWith,
  pendingReason,
  className,
}: {
  unlocksWith: string;
  pendingReason: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 px-6 py-10 text-center",
        className,
      )}
    >
      <span className="inline-flex items-center rounded-full border bg-background px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Unlocks with {unlocksWith}
      </span>
      <p className="mt-3 max-w-md text-sm text-muted-foreground">
        {pendingReason ??
          `This section will populate once ${unlocksWith} is available.`}
      </p>
    </div>
  );
}
