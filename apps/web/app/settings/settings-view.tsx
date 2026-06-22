"use client";

import { useSearchParams } from "next/navigation";
import * as React from "react";

import { OptOutToggle } from "@/components/attrition/opt-out-toggle";

/**
 * SettingsView (client) — the employee's privacy preferences, including the
 * Module 7 attrition opt-out.
 *
 * In production the employee is resolved from the authenticated Clerk session
 * (the API is the auth boundary). In this Phase-1 web foundation the employee id
 * is read from `?employee=` so the control can be exercised in dev, and the
 * current opt-out state from `?optOut=true` (otherwise defaults to included).
 * The toggle persists via `api.setAttritionOptOut`; the score itself is never
 * shown to the employee.
 */
export function SettingsView() {
  const searchParams = useSearchParams();
  const employeeId = searchParams.get("employee") ?? "";
  const initialOptOut = searchParams.get("optOut") === "true";

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2 border-b pb-2">
        <h2 className="text-lg font-medium">Data &amp; privacy</h2>
      </div>

      {employeeId === "" ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No employee in context. In production you would see your own settings;
          in dev, append <code>?employee=&lt;your-employee-id&gt;</code> to manage
          the attrition opt-out.
        </p>
      ) : (
        <OptOutToggle employeeId={employeeId} initialOptOut={initialOptOut} />
      )}
    </section>
  );
}
