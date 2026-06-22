"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { InclusiveFlagList } from "@/components/copilot/inclusive-flag-list";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { api, ApiClientError, type WriteJdInput } from "@/lib/api";
import type { GeneratedJobDescription, RoleLevel } from "@peopleos/schemas";

/**
 * Module 2a — Job Description Writer panel.
 *
 * A recruiter fills the brief (role title, seniority, department, team context,
 * hiring-manager notes); `api.writeJd` calls the AI service (the API supplies
 * the org's prior JDs as tone-matched few-shot + orgContext server-side). The
 * generated JD is rendered as discrete sections, with the inclusive-language
 * flags (phrase → suggestion, by category) and a bias check, plus a
 * "copy / use as JD text" action over the fully assembled `jdText`.
 */

/** The ordered seniority options — values are the frozen `RoleLevel` enum. */
const SENIORITY_OPTIONS: ReadonlyArray<{ value: RoleLevel; label: string }> = [
  { value: "INTERN", label: "Intern" },
  { value: "JUNIOR", label: "Junior" },
  { value: "MID", label: "Mid" },
  { value: "SENIOR", label: "Senior" },
  { value: "STAFF", label: "Staff" },
  { value: "PRINCIPAL", label: "Principal" },
  { value: "MANAGER", label: "Manager" },
  { value: "DIRECTOR", label: "Director" },
  { value: "VP", label: "VP" },
  { value: "EXEC", label: "Exec" },
];

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function JdWriter() {
  const [roleTitle, setRoleTitle] = React.useState("");
  const [seniority, setSeniority] = React.useState<RoleLevel | "">("");
  const [department, setDepartment] = React.useState("");
  const [teamContext, setTeamContext] = React.useState("");
  const [hiringManagerNotes, setHiringManagerNotes] = React.useState("");

  const write = useMutation<GeneratedJobDescription, Error, WriteJdInput>({
    mutationFn: (input) => api.writeJd(input),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const title = roleTitle.trim();
    if (!title) return;
    write.mutate({
      roleTitle: title,
      seniority: seniority === "" ? null : seniority,
      department: department.trim() || null,
      teamContext: teamContext.trim() || null,
      hiringManagerNotes: hiringManagerNotes.trim() || null,
    });
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="jd-role" className="text-sm font-medium">
            Role title <span className="text-destructive">*</span>
          </label>
          <input
            id="jd-role"
            className={fieldClass}
            value={roleTitle}
            onChange={(e) => setRoleTitle(e.target.value)}
            placeholder="Senior Machine Learning Engineer"
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="jd-seniority" className="text-sm font-medium">
            Seniority
          </label>
          <select
            id="jd-seniority"
            className={fieldClass}
            value={seniority}
            onChange={(e) => setSeniority(e.target.value as RoleLevel | "")}
          >
            <option value="">—</option>
            {SENIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="jd-department" className="text-sm font-medium">
            Department
          </label>
          <input
            id="jd-department"
            className={fieldClass}
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="Engineering"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="jd-team" className="text-sm font-medium">
            Team context
          </label>
          <textarea
            id="jd-team"
            className={fieldClass}
            rows={3}
            value={teamContext}
            onChange={(e) => setTeamContext(e.target.value)}
            placeholder="The Applied ML team owns the candidate-ranking models…"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="jd-notes" className="text-sm font-medium">
            Hiring manager notes
          </label>
          <textarea
            id="jd-notes"
            className={fieldClass}
            rows={3}
            value={hiringManagerNotes}
            onChange={(e) => setHiringManagerNotes(e.target.value)}
            placeholder="Must have shipped production LLM features; remote-friendly."
          />
        </div>

        <Button type="submit" disabled={write.isPending || roleTitle.trim() === ""}>
          {write.isPending ? "Generating…" : "Generate JD"}
        </Button>

        {write.isError ? (
          <p className="text-xs text-destructive">
            {write.error instanceof ApiClientError
              ? `${write.error.code}: ${write.error.message}`
              : write.error.message}
          </p>
        ) : null}
      </form>

      <div className="min-w-0">
        {write.data ? (
          <GeneratedJd jd={write.data} />
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            Fill the brief and generate a job description. The result appears here
            with inclusive-language flags and a copyable JD text.
          </div>
        )}
      </div>
    </div>
  );
}

function GeneratedJd({ jd }: { jd: GeneratedJobDescription }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">{jd.title}</h2>
          <p className="text-xs text-muted-foreground">
            {jd.modelVersion}
            {jd.promptVersion ? ` · prompt ${jd.promptVersion}` : null}
          </p>
        </div>
        <CopyButton
          value={jd.jdText}
          label="Copy / use as JD text"
          copiedLabel="Copied JD text"
        />
      </div>

      <p className="text-sm text-muted-foreground">{jd.summary}</p>

      <Section title="Responsibilities" items={jd.responsibilities} />
      <Section title="Requirements" items={jd.requirements} />
      <Section title="Preferred" items={jd.preferred} />
      <Section title="Benefits" items={jd.benefits} />

      <div className="space-y-1.5">
        <h3 className="text-sm font-medium">DEI statement</h3>
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {jd.deiStatement}
        </p>
      </div>

      <div className="border-t pt-4">
        <InclusiveFlagList report={jd.inclusiveLanguage} />
      </div>
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
