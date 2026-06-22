"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  CATEGORY_LABEL,
  PROFICIENCY_LABEL,
  PROFICIENCY_ORDER,
} from "@/components/skills/skill-display";
import { api, ApiClientError } from "@/lib/api";
import type {
  AddEmployeeSkillRequest,
  EmployeeSkillProfile,
  ProficiencyLevel,
  Skill,
} from "@peopleos/schemas";

/**
 * AddSkillControl — Module 6a employee self-report. The employee picks an
 * existing catalog skill (`api.listSkills`) and a proficiency, then submits the
 * frozen `AddEmployeeSkillRequest` ({ skillId, proficiency }). The API records it
 * as SELF_REPORTED with confidence 0.5 (`confidenceForSource`) — the client never
 * sends a confidence or source — which "triggers a re-verification flow" (the
 * record then shows as awaiting manager verification, spec 6a/6d).
 *
 * Skills the employee already holds are excluded from the picker. On success the
 * profile query is invalidated so the new badge appears with its self-report
 * confidence dot.
 */
export function AddSkillControl({
  employeeId,
  /** Skill ids the employee already has (excluded from the picker). */
  ownedSkillIds,
}: {
  employeeId: string;
  ownedSkillIds: ReadonlyArray<string>;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [skillId, setSkillId] = React.useState("");
  const [proficiency, setProficiency] =
    React.useState<ProficiencyLevel>("PRACTITIONER");

  const catalog = useQuery<Skill[], Error>({
    queryKey: ["skills", "catalog"],
    queryFn: () => api.listSkills(),
    enabled: open,
  });

  const add = useMutation<EmployeeSkillProfile, Error, AddEmployeeSkillRequest>({
    mutationFn: (input) => api.addEmployeeSkill(employeeId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["skills", "profile", employeeId],
      });
      setSkillId("");
      setProficiency("PRACTITIONER");
      setOpen(false);
    },
  });

  const owned = React.useMemo(() => new Set(ownedSkillIds), [ownedSkillIds]);
  const available = React.useMemo(
    () => (catalog.data ?? []).filter((s) => !owned.has(s.id)),
    [catalog.data, owned],
  );

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        + Add a skill
      </Button>
    );
  }

  return (
    <form
      className="space-y-3 rounded-lg border bg-muted/20 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (skillId) add.mutate({ skillId, proficiency });
      }}
    >
      <p className="text-xs text-muted-foreground">
        Self-reported skills start at 0.5 confidence and are sent to your manager
        for verification.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="add-skill" className="text-sm font-medium">
            Skill
          </label>
          <select
            id="add-skill"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            value={skillId}
            onChange={(e) => setSkillId(e.target.value)}
            disabled={catalog.isLoading}
          >
            <option value="">
              {catalog.isLoading ? "Loading catalog…" : "Select a skill…"}
            </option>
            {available.map((s) => (
              <option key={s.id} value={s.id}>
                {s.canonicalName} · {CATEGORY_LABEL[s.category]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="add-proficiency" className="text-sm font-medium">
            Proficiency
          </label>
          <select
            id="add-proficiency"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            value={proficiency}
            onChange={(e) => setProficiency(e.target.value as ProficiencyLevel)}
          >
            {PROFICIENCY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PROFICIENCY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!skillId || add.isPending}>
          {add.isPending ? "Adding…" : "Add skill"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={add.isPending}
        >
          Cancel
        </Button>
        {catalog.isError ? (
          <span className="text-xs text-destructive">
            Could not load the skill catalog.
          </span>
        ) : null}
        {add.isError ? (
          <span className="text-xs text-destructive">
            {add.error instanceof ApiClientError
              ? `${add.error.code}: ${add.error.message}`
              : add.error.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
