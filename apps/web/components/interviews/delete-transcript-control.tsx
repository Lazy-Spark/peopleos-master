"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/api";
import type { InterviewScorecard } from "@peopleos/schemas";

/**
 * DeleteTranscriptControl — the DSAR transcript-deletion control (Module 3
 * privacy: "candidate can request transcript deletion via DSAR flow"; also used
 * for org retention enforcement, default 90 days).
 *
 * Deleting permanently removes the encrypted transcript (S3 SSE-KMS). It is
 * IRREVERSIBLE, so it is gated behind an explicit two-step confirm. The derived
 * scorecard / calibration flags are retained (they no longer reference raw
 * audio); only the transcript itself is destroyed.
 *
 * Calls `api.deleteTranscript` (DELETE /interviews/:id/transcript) and refreshes
 * the page so the transcript view reflects the deleted state.
 */
export function DeleteTranscriptControl({
  interviewId,
  /** Whether a transcript is currently present (hides the control once gone). */
  hasTranscript,
}: {
  interviewId: string;
  hasTranscript: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);

  const del = useMutation<InterviewScorecard, Error>({
    mutationFn: () => api.deleteTranscript(interviewId),
    onSuccess: () => {
      setConfirming(false);
      router.refresh();
    },
  });

  if (!hasTranscript) {
    return (
      <p className="text-xs text-muted-foreground">
        No transcript on file — it was never processed, or has already been deleted
        (retention / DSAR).
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {!confirming ? (
        <Button
          variant="outline"
          size="sm"
          className="border-destructive/50 text-destructive hover:bg-destructive/10"
          onClick={() => setConfirming(true)}
        >
          Delete transcript (DSAR)
        </Button>
      ) : (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-xs text-destructive">
            Permanently delete this candidate&apos;s encrypted transcript? This cannot
            be undone. The submitted scorecard is retained; only the raw transcript
            is destroyed.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => del.mutate()}
              disabled={del.isPending}
            >
              {del.isPending ? "Deleting…" : "Confirm delete"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={del.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {del.isError ? (
        <p className="text-xs text-destructive">
          {del.error instanceof ApiClientError
            ? `${del.error.code}: ${del.error.message}`
            : del.error.message}
        </p>
      ) : null}
    </div>
  );
}
