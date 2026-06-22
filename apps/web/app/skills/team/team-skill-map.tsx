"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { SkillHeatmap } from "@/components/skills/skill-heatmap";
import { api, ApiClientError } from "@/lib/api";
import type { TeamSkillMap as TeamSkillMapT } from "@peopleos/schemas";

/**
 * TeamSkillMapView (Module 6b, client) — the manager-facing team heatmap.
 *
 * Resolves a `managerId` from the `?manager=` query param (so a deep link from a
 * span-of-control row works), fetches `api.getTeamSkillMap`, and renders:
 *   - the members × skills heatmap (cell = proficiency, hover = confidence),
 *   - the BUS-FACTOR list (skills held by exactly one report — single point of
 *     failure, spec 6b),
 *   - the BENCH STRENGTH list (holder count per skill).
 *
 * All values come from the API-computed `TeamSkillMap` contract.
 */
export function TeamSkillMapView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const managerId = searchParams.get("manager") ?? "";

  const [input, setInput] = React.useState(managerId);
  React.useEffect(() => setInput(managerId), [managerId]);

  const map = useQuery<TeamSkillMapT, Error>({
    queryKey: ["skills", "team", managerId],
    queryFn: () => api.getTeamSkillMap(managerId),
    enabled: managerId !== "",
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    if (input.trim()) params.set("manager", input.trim());
    else params.delete("manager");
    router.replace(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <label htmlFor="manager-id" className="text-sm font-medium">
            Manager
          </label>
          <input
            id="manager-id"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            placeholder="Manager employee ID"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={!input.trim()}>
          View team
        </Button>
      </form>

      {managerId === "" ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Enter a manager&apos;s employee ID to see their team&apos;s skill
          coverage, bus-factor risks, and bench strength.
        </p>
      ) : map.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading team skill map…</p>
      ) : map.isError || !map.data ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {map.error instanceof ApiClientError
            ? `${map.error.code}: ${map.error.message}`
            : "Could not load the team skill map."}
        </div>
      ) : (
        <TeamSkillMapContent map={map.data} />
      )}
    </div>
  );
}

function TeamSkillMapContent({ map }: { map: TeamSkillMapT }) {
  // Bus-factor first (most urgent), then strongest bench coverage.
  const busFactor = [...map.busFactor].sort((a, b) =>
    a.skillName.localeCompare(b.skillName),
  );
  const benchStrength = [...map.benchStrength].sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-baseline gap-2 border-b pb-2">
          <h2 className="text-lg font-medium">Skill heatmap</h2>
          <span className="text-xs text-muted-foreground">
            {map.members.length} report{map.members.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Cell number = proficiency (1 Aware → 4 Expert); hover for confidence.
          Columns shaded red are bus-factor risks (only one holder).
        </p>
        <SkillHeatmap map={map} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2 rounded-lg border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            Bus-factor risks
            {busFactor.length > 0 ? (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                {busFactor.length}
              </span>
            ) : null}
          </h3>
          <p className="text-xs text-muted-foreground">
            Skills held by only one team member — a single point of failure.
          </p>
          {busFactor.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No single-holder skills. Coverage is resilient.
            </p>
          ) : (
            <ul className="divide-y rounded-md border border-destructive/30">
              {busFactor.map((b) => (
                <li
                  key={b.skillId}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="font-medium text-foreground">{b.skillName}</span>
                  <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                    {b.holders} holder
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2 rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium">Bench strength</h3>
          <p className="text-xs text-muted-foreground">
            How many team members hold each skill — deeper benches are resilient.
          </p>
          {benchStrength.length === 0 ? (
            <p className="text-sm text-muted-foreground">No skills recorded.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {benchStrength.map((b) => (
                <li
                  key={b.skillId}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="font-medium text-foreground">{b.skillName}</span>
                  <span
                    className={cnCount(b.count)}
                  >
                    {b.count} holder{b.count === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** Deep benches read green; a lone holder reads amber (an early bus-factor cue). */
function cnCount(count: number): string {
  const base = "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ";
  if (count <= 1) return base + "bg-amber-600/10 text-amber-700";
  if (count >= 3) return base + "bg-emerald-600/10 text-emerald-700";
  return base + "bg-muted text-muted-foreground";
}
