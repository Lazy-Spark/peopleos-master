import * as React from "react";

import { SettingsView } from "./settings-view";

/**
 * Employee settings route shell (Module 7 — the opt-out control lives here).
 *
 * A thin Server Component wrapper around the client `SettingsView`, which renders
 * the employee-facing attrition opt-out toggle (`OptOutToggle` →
 * `api.setAttritionOptOut`). The attrition score is never shown to the employee;
 * this is the one attrition surface they see, and it controls only whether they
 * are profiled at all. All wire shapes come from `@peopleos/schemas`.
 */
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your data and privacy preferences.
        </p>
      </section>

      <React.Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <SettingsView />
      </React.Suspense>
    </div>
  );
}
