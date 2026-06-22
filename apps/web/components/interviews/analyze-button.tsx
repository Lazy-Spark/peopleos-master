"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/api";
import type { AnalyzeInterviewResponse } from "@peopleos/schemas";

/**
 * AnalyzeButton — runs the 4-step Module 3 analysis (POST /interviews/:id/analyze
 * → `AnalyzeInterviewResponse`) to produce the AI scorecard draft, the
 * competency/STAR evidence, and the calibration flags. On success it refreshes
 * the page so the Server Component re-pulls the now-populated, persisted
 * scorecard. Used when no AI draft exists yet, or to re-analyse.
 *
 * Requires a transcript: analysis is gated on consent + an available transcript
 * server-side, so the button is disabled when no transcript is present.
 */
export function AnalyzeButton({
  interviewId,
  hasTranscript,
  hasDraft,
}: {
  interviewId: string;
  hasTranscript: boolean;
  hasDraft: boolean;
}) {
  const router = useRouter();

  const analyze = useMutation<AnalyzeInterviewResponse, Error>({
    mutationFn: () => api.analyzeInterview(interviewId),
    onSuccess: () => router.refresh(),
  });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        variant={hasDraft ? "outline" : "default"}
        onClick={() => analyze.mutate()}
        disabled={analyze.isPending || !hasTranscript}
        title={!hasTranscript ? "A transcript is required before analysis" : undefined}
      >
        {analyze.isPending ? "Analysing…" : hasDraft ? "Re-run analysis" : "Run analysis"}
      </Button>
      {!hasTranscript ? (
        <span className="text-xs text-muted-foreground">
          Awaiting transcript — analysis runs once the interview is transcribed.
        </span>
      ) : null}
      {analyze.isError ? (
        <span className="text-xs text-destructive">
          {analyze.error instanceof ApiClientError
            ? `${analyze.error.code}: ${analyze.error.message}`
            : analyze.error.message}
        </span>
      ) : null}
    </div>
  );
}
