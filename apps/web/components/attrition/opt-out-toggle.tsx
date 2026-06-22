"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { cn } from "@/lib/utils";
import { api, ApiClientError } from "@/lib/api";

/**
 * OptOutToggle — the employee's "right to not be profiled" control (spec Module 7
 * ethics: an opt-out mechanism is REQUIRED). When enabled, the employee is
 * EXCLUDED from attrition scoring entirely — no score is computed or surfaced for
 * them. The attrition score is ADVISORY and is NEVER shown to the employee; this
 * toggle is the one attrition surface an employee sees, and it controls only
 * their participation.
 *
 * Calls `api.setAttritionOptOut(employeeId, optOut)`. The current value is
 * supplied by the caller (the API resolves it from the employee's record
 * server-side); this component owns the optimistic toggle + persistence.
 */
export function OptOutToggle({
  employeeId,
  /** The employee's current opt-out state (from their record). */
  initialOptOut,
  className,
}: {
  employeeId: string;
  initialOptOut: boolean;
  className?: string;
}) {
  const [optedOut, setOptedOut] = React.useState(initialOptOut);
  React.useEffect(() => setOptedOut(initialOptOut), [initialOptOut]);

  const mutation = useMutation<void, Error, boolean>({
    mutationFn: (next) => api.setAttritionOptOut(employeeId, next),
    onSuccess: (_data, next) => setOptedOut(next),
  });

  const toggle = () => {
    if (mutation.isPending) return;
    // Persist first; only flip the displayed state on success (onSuccess above),
    // so a failed save leaves the toggle on its last-saved value and surfaces the
    // error in the status line below.
    mutation.mutate(!optedOut);
  };

  return (
    <div className={cn("rounded-lg border bg-card p-4", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Exclude me from attrition risk prediction
          </p>
          <p className="text-xs text-muted-foreground">
            PeopleOS can estimate retention risk to help your organisation support
            employees. This estimate is advisory only and is never shown to you.
            You can opt out at any time — if you do, no risk score is computed for
            you and you are excluded from this analysis entirely.
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={optedOut}
          aria-label="Opt out of attrition risk prediction"
          onClick={toggle}
          disabled={mutation.isPending}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50",
            optedOut ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform",
              optedOut ? "translate-x-5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        {mutation.isPending
          ? "Saving…"
          : optedOut
            ? "You are currently opted out of attrition risk prediction."
            : "You are currently included in attrition risk prediction."}
        {mutation.isError ? (
          <span className="ml-1 text-destructive">
            {mutation.error instanceof ApiClientError
              ? `Could not save (${mutation.error.code}).`
              : "Could not save your preference."}
          </span>
        ) : null}
      </p>
    </div>
  );
}
