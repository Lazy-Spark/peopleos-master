import * as React from "react";

import { ManagerAttritionTeam } from "./manager-attrition-team";

/**
 * Module 7 — Manager attrition view route shell.
 *
 * A thin Server Component wrapper around the client `ManagerAttritionTeam`. The
 * manager sees ONLY the redacted `ManagerAttritionView` per report — the risk
 * TIER + recommended talking points. By contract (and enforced server-side) the
 * manager NEVER receives the raw score, the SHAP values, or the feature values;
 * this surface renders none of them. The score is also never shown to the
 * employee. All wire shapes come from `@peopleos/schemas`.
 */
export const dynamic = "force-dynamic";

export default function ManagerAttritionPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Team retention check-in
        </h1>
        <p className="text-sm text-muted-foreground">
          A supportive view of where your reports may need attention, with
          suggested talking points. You see a risk level and recommendations
          only — never a numeric score or the underlying signals. Use these to
          start a conversation, not to make a decision.
        </p>
      </section>

      <div className="rounded-lg border border-amber-600/30 bg-amber-600/5 p-3 text-xs text-amber-800">
        <span className="font-medium">Advisory only.</span> These risk levels are
        estimates to help you check in with your team. They never trigger any
        automated action, and they are{" "}
        <span className="font-medium">never shown to the employee</span>.
      </div>

      <ManagerAttritionTeam />
    </div>
  );
}
