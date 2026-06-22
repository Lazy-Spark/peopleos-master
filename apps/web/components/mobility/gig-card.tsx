"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MatchBar } from "@/components/mobility/match-bar";
import { SkillGapChips } from "@/components/mobility/skill-gap-chips";
import { api, ApiClientError } from "@/lib/api";
import type { GigStatus } from "@peopleos/schemas";

/**
 * GigCard — one gig / stretch assignment in the marketplace (8c).
 *
 * Renders the gig's title, description, duration, required skills, and status,
 * with an "Express interest" action. Expressing interest acts on the viewing
 * employee's OWN behalf — the API resolves the acting employee from the session,
 * so this only POSTs the gig id (and notifies the HRBP without alerting the
 * employee's manager, per spec). When the card is shown as a recommendation it
 * also renders the skill-coverage `matchScore` + matched / missing breakdown.
 *
 * Interest can only be expressed while the gig is OPEN. The acting employee id is
 * passed only as a guard for the dev session context (the API is the authority).
 */
const STATUS_CLASS: Record<GigStatus, string> = {
  OPEN: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
  FILLED: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  CLOSED: "border-muted-foreground/30 bg-muted text-muted-foreground",
};

export function GigCard({
  gigId,
  title,
  description,
  requiredSkills,
  durationWeeks,
  status,
  /** Recommendation-only: skill-coverage match for the viewing employee. */
  match,
  /** When false (no employee in dev context), the interest action is disabled. */
  canExpressInterest = true,
  className,
}: {
  gigId: string;
  title: string;
  description?: string;
  requiredSkills: readonly string[];
  durationWeeks: number | null;
  status?: GigStatus;
  match?: {
    score: number;
    matchedSkills: readonly string[];
    missingSkills: readonly string[];
  };
  canExpressInterest?: boolean;
  className?: string;
}) {
  const interest = useMutation<void, Error>({
    mutationFn: () => api.expressGigInterest(gigId),
  });

  const isOpen = status === undefined || status === "OPEN";
  const expressed = interest.isSuccess;

  return (
    <div className={cn("space-y-3 rounded-lg border p-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{title}</h3>
            {status ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  STATUS_CLASS[status],
                )}
              >
                {status}
              </span>
            ) : null}
          </div>
          {durationWeeks !== null ? (
            <p className="text-xs text-muted-foreground">
              {durationWeeks} week{durationWeeks === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>
        {match ? (
          <div className="w-36 shrink-0">
            <MatchBar value={match.score} />
          </div>
        ) : null}
      </div>

      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}

      {match ? (
        <SkillGapChips
          matched={match.matchedSkills}
          missing={match.missingSkills}
        />
      ) : requiredSkills.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Skills
          </span>
          {requiredSkills.map((skill) => (
            <span
              key={skill}
              className="inline-flex items-center rounded-full border border-input bg-card px-2 py-0.5 text-xs"
            >
              {skill}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-3 border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => interest.mutate()}
          disabled={
            !isOpen || !canExpressInterest || interest.isPending || expressed
          }
        >
          {expressed
            ? "Interest expressed"
            : interest.isPending
              ? "Submitting…"
              : "Express interest"}
        </Button>
        {!isOpen ? (
          <span className="text-xs text-muted-foreground">
            This gig is no longer open.
          </span>
        ) : !canExpressInterest ? (
          <span className="text-xs text-muted-foreground">
            Add <code>?employee=&lt;id&gt;</code> to express interest in dev.
          </span>
        ) : null}
      </div>

      {interest.isError ? (
        <p className="text-xs text-destructive">
          {interest.error instanceof ApiClientError
            ? `${interest.error.code}: ${interest.error.message}`
            : interest.error.message}
        </p>
      ) : null}
    </div>
  );
}
