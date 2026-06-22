"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { api, ApiClientError, type SubmitScorecardInput } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AiScorecardDraft,
  InterviewScorecard,
  ScorecardRecommendation,
} from "@peopleos/schemas";

/**
 * ReviewerScorecardForm — the human-in-the-loop scorecard (Module 3 step 3:
 * "auto-populate scorecard … structured fields + free-text"). The reviewer edits
 * the per-competency 1-5 scores (seeded from the AI draft or a prior submission)
 * and the overall recommendation, then submits via `api.submitScorecard`.
 *
 * The AI draft is ADVISORY: it pre-fills the form so the reviewer can confirm or
 * override, never decide on its own. Submitted via the frozen
 * `SubmitScorecardRequest` shape (`SubmitScorecardInput`); the response is the
 * persisted `InterviewScorecard`. Typed off `@peopleos/schemas` only.
 */

const RECOMMENDATIONS: ReadonlyArray<{ value: ScorecardRecommendation; label: string }> = [
  { value: "STRONG_YES", label: "Strong yes" },
  { value: "YES", label: "Yes" },
  { value: "NO", label: "No" },
  { value: "STRONG_NO", label: "Strong no" },
];

const SCORE_OPTIONS = [1, 2, 3, 4, 5] as const;

type Row = {
  competencyId: string;
  competencyName: string;
  score: number;
  evidence: string;
};

/**
 * Seed the editable rows. Prefer the reviewer's prior submission (so re-edits
 * are non-destructive), falling back to the AI draft's competency scores. The
 * AI draft carries human-readable names; the persisted scores carry only ids.
 */
function seedRows(
  draft: AiScorecardDraft | null,
  persisted: InterviewScorecard["competencyScores"],
): Row[] {
  const nameById = new Map<string, string>();
  for (const cs of draft?.competencyScores ?? []) {
    nameById.set(cs.competencyId, cs.competencyName);
  }

  if (persisted.length > 0) {
    return persisted.map((p) => ({
      competencyId: p.competencyId,
      competencyName: nameById.get(p.competencyId) ?? p.competencyId,
      score: clampScore(p.score),
      evidence: p.evidence ?? "",
    }));
  }

  return (draft?.competencyScores ?? []).map((cs) => ({
    competencyId: cs.competencyId,
    competencyName: cs.competencyName,
    score: clampScore(cs.score),
    evidence: cs.evidenceQuote,
  }));
}

function clampScore(n: number): number {
  return Math.min(5, Math.max(1, Math.round(n)));
}

export function ReviewerScorecardForm({
  scorecard,
}: {
  scorecard: InterviewScorecard;
}) {
  const router = useRouter();
  const draft = scorecard.aiScorecardDraft;

  const [rows, setRows] = React.useState<Row[]>(() =>
    seedRows(draft, scorecard.competencyScores),
  );
  const [overall, setOverall] = React.useState<ScorecardRecommendation>(
    scorecard.overall ?? draft?.overallRecommendation ?? "YES",
  );

  const submit = useMutation<InterviewScorecard, Error, SubmitScorecardInput>({
    // Reviewer submission is keyed by the scorecard id (the AI draft row).
    mutationFn: (input) => api.submitScorecard(scorecard.id, input),
    onSuccess: () => router.refresh(),
  });

  const setScore = (competencyId: string, score: number) =>
    setRows((prev) =>
      prev.map((r) => (r.competencyId === competencyId ? { ...r, score } : r)),
    );

  const setEvidence = (competencyId: string, evidence: string) =>
    setRows((prev) =>
      prev.map((r) => (r.competencyId === competencyId ? { ...r, evidence } : r)),
    );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit.mutate({
      competencyScores: rows.map((r) => ({
        competencyId: r.competencyId,
        score: r.score,
        evidence: r.evidence.trim() || null,
      })),
      overallRecommendation: overall,
    });
  };

  const alreadySubmitted = scorecard.submittedAt !== null;

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">Your scorecard</h2>
        {alreadySubmitted ? (
          <span className="text-xs text-muted-foreground">
            Submitted {new Date(scorecard.submittedAt!).toLocaleString()} — editing
            re-submits.
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            Pre-filled from the AI draft — confirm or override.
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No competencies to score. Run analysis to populate the scorecard template.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.competencyId} className="space-y-2 border-b pb-3 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{row.competencyName}</span>
                <fieldset
                  className="flex items-center gap-1"
                  aria-label={`${row.competencyName} score, 1 to 5`}
                >
                  {SCORE_OPTIONS.map((n) => (
                    <label
                      key={n}
                      className={cn(
                        "flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border text-sm tabular-nums transition-colors",
                        row.score === n
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-background hover:bg-accent",
                      )}
                    >
                      <input
                        type="radio"
                        name={`score-${row.competencyId}`}
                        value={n}
                        checked={row.score === n}
                        onChange={() => setScore(row.competencyId, n)}
                        className="sr-only"
                      />
                      {n}
                    </label>
                  ))}
                </fieldset>
              </div>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                rows={2}
                value={row.evidence}
                onChange={(e) => setEvidence(row.competencyId, e.target.value)}
                placeholder="Evidence / notes (a transcript quote pre-fills from the AI draft)"
                aria-label={`${row.competencyName} evidence`}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1.5">
        <label htmlFor="overall-rec" className="text-sm font-medium">
          Overall recommendation
        </label>
        <select
          id="overall-rec"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          value={overall}
          onChange={(e) => setOverall(e.target.value as ScorecardRecommendation)}
        >
          {RECOMMENDATIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submit.isPending}>
          {submit.isPending
            ? "Submitting…"
            : alreadySubmitted
              ? "Re-submit scorecard"
              : "Submit scorecard"}
        </Button>
        {submit.isSuccess ? (
          <span className="text-xs text-green-700">Scorecard saved.</span>
        ) : null}
      </div>

      {submit.isError ? (
        <p className="text-xs text-destructive">
          {submit.error instanceof ApiClientError
            ? `${submit.error.code}: ${submit.error.message}`
            : submit.error.message}
        </p>
      ) : null}
    </form>
  );
}
