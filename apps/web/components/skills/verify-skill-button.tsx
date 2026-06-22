"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { PROFICIENCY_LABEL, PROFICIENCY_ORDER } from "@/components/skills/skill-display";
import { api, ApiClientError } from "@/lib/api";
import type {
  ProficiencyLevel,
  SkillRecordView,
  VerifySkillRequest,
} from "@peopleos/schemas";

/**
 * VerifySkillButton — Module 6d manager verification (single click).
 *
 * Confirms a claimed skill record → source MANAGER_VERIFIED, confidence 0.8
 * (server-derived via `confidenceForSource`; never sent by the client). The
 * manager may optionally adjust the proficiency before confirming (the frozen
 * `VerifySkillRequest.proficiency?`).
 *
 * Authorisation is enforced server-side (ADMIN / HRBP / MANAGER); the parent
 * passes `canVerify` to decide whether to render the control at all — mirroring
 * the rest of the app where the API is the auth boundary. Already-verified
 * records render a static badge instead of the action.
 *
 * On success it invalidates the relevant skill queries so the profile / heatmap
 * re-render with the new confidence + verified state.
 */
export function VerifySkillButton({
  record,
  canVerify,
  /** Query keys to invalidate on success (e.g. the employee's profile). */
  invalidateKeys = [],
}: {
  record: SkillRecordView;
  canVerify: boolean;
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}) {
  const queryClient = useQueryClient();
  const [proficiency, setProficiency] = React.useState<ProficiencyLevel>(
    record.proficiency,
  );

  const verify = useMutation<SkillRecordView, Error, VerifySkillRequest>({
    mutationFn: (input) => api.verifySkill(record.id, input),
    onSuccess: () => {
      for (const key of invalidateKeys) {
        void queryClient.invalidateQueries({ queryKey: key as unknown[] });
      }
    },
  });

  const alreadyVerified = record.verifiedAt !== null;

  if (alreadyVerified) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
        <span aria-hidden>✓</span> Verified
      </span>
    );
  }

  if (!canVerify) {
    // Unverified, but the viewer can't verify — show provenance only, no action.
    return (
      <span className="text-xs text-muted-foreground">Awaiting verification</span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`verify-prof-${record.id}`}>
        Adjust proficiency before verifying
      </label>
      <select
        id={`verify-prof-${record.id}`}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        value={proficiency}
        onChange={(e) => setProficiency(e.target.value as ProficiencyLevel)}
        disabled={verify.isPending}
      >
        {PROFICIENCY_ORDER.map((p) => (
          <option key={p} value={p}>
            {PROFICIENCY_LABEL[p]}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        onClick={() =>
          verify.mutate(
            // Only send a proficiency override when the manager actually changed it.
            proficiency === record.proficiency ? {} : { proficiency },
          )
        }
        disabled={verify.isPending}
      >
        {verify.isPending ? "Verifying…" : "Verify"}
      </Button>
      {verify.isError ? (
        <span className="text-xs text-destructive">
          {verify.error instanceof ApiClientError
            ? `${verify.error.code}: ${verify.error.message}`
            : verify.error.message}
        </span>
      ) : null}
    </div>
  );
}
