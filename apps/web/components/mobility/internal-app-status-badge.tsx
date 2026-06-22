import * as React from "react";

import { cn } from "@/lib/utils";
import type { InternalAppStatus } from "@peopleos/schemas";

/**
 * InternalAppStatusBadge — the pipeline status of an internal application
 * (Module 8 InternalAppStatus: INTERESTED → APPLIED → SHORTLISTED → HIRED, or
 * WITHDRAWN / REJECTED).
 *
 * Purely presentational; the status is driven entirely by the contract value.
 */
const STATUS_CLASS: Record<InternalAppStatus, string> = {
  INTERESTED: "border-muted-foreground/30 bg-muted text-muted-foreground",
  APPLIED: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  SHORTLISTED: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  HIRED: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
  WITHDRAWN: "border-muted-foreground/30 bg-muted text-muted-foreground",
  REJECTED: "border-destructive/40 bg-destructive/10 text-destructive",
};

const STATUS_LABEL: Record<InternalAppStatus, string> = {
  INTERESTED: "Interested",
  APPLIED: "Applied",
  SHORTLISTED: "Shortlisted",
  HIRED: "Hired",
  WITHDRAWN: "Withdrawn",
  REJECTED: "Rejected",
};

export function InternalAppStatusBadge({
  status,
  className,
}: {
  status: InternalAppStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        STATUS_CLASS[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export { STATUS_LABEL as INTERNAL_APP_STATUS_LABEL };
