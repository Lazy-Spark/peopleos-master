import Link from "next/link";
import { notFound } from "next/navigation";

import { AnalyzeButton } from "@/components/interviews/analyze-button";
import { CalibrationFlags } from "@/components/interviews/calibration-flags";
import { ConsentIndicator } from "@/components/interviews/consent-indicator";
import { DeleteTranscriptControl } from "@/components/interviews/delete-transcript-control";
import { ReviewerScorecardForm } from "@/components/interviews/reviewer-scorecard-form";
import { ScorecardDraftView } from "@/components/interviews/scorecard-draft-view";
import { api, ApiClientError } from "@/lib/api";
import type {
  CalibrationFlag,
  InterviewScorecard,
  InterviewSummary,
  PanelCalibration,
} from "@peopleos/schemas";

export const dynamic = "force-dynamic";

/**
 * Interview Intelligence (Module 3) — review surface for a single interview.
 *
 * Server Component. Privacy is central: the RAW TRANSCRIPT IS NEVER FETCHED to the
 * browser (it lives encrypted in S3 and is never returned by the API). The review
 * surface shows only the AI scorecard draft — whose evidence quotes are the only
 * transcript-derived text exposed — plus the panel calibration and the reviewer's
 * human-in-the-loop scorecard. We fetch:
 *   - the interview governance view (consent + transcript status + hasTranscript),
 *   - the AI/reviewer scorecard (absent until analysis has run),
 *   - the candidate's panel calibration (score divergence + AI flags).
 */
export default async function InterviewPage({
  params,
}: {
  params: { id: string };
}) {
  // Primary fetch: the governance view. A 404 means the interview is not in this org.
  let interview: InterviewSummary;
  try {
    interview = await api.getInterview(params.id);
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) notFound();
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorCard err={err} />
      </div>
    );
  }

  // The scorecard is absent until analysis has run (404 → not analysed yet, not an error).
  let scorecard: InterviewScorecard | null = null;
  try {
    scorecard = await api.getInterviewScorecard(params.id);
  } catch (err) {
    if (!(err instanceof ApiClientError) || err.status !== 404) {
      return (
        <div className="space-y-4">
          <BackLink />
          <ErrorCard err={err} />
        </div>
      );
    }
  }

  // Panel calibration spans the candidate's whole panel; keyed by applicationId.
  let calibration: PanelCalibration | null = null;
  try {
    calibration = await api.getCalibration(interview.applicationId);
  } catch {
    calibration = null;
  }

  const hasTranscript = interview.hasTranscript;
  const draft = scorecard?.aiScorecardDraft ?? null;

  // Merge the per-interview flags stored on the scorecard with the panel-wide AI
  // flags + computed score-divergence flags from calibration (deduped).
  const flags = mergeFlags(
    scorecard?.calibrationFlags ?? [],
    calibration?.aiFlags ?? [],
    calibration ? divergenceFlags(calibration) : [],
  );

  return (
    <div className="space-y-6">
      <BackLink />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Interview review</h1>
          <p className="text-sm text-muted-foreground">
            Interview {interview.id} · application {interview.applicationId}
          </p>
        </div>
        <ConsentIndicator obtained={interview.consentObtained} />
      </header>

      <div className="rounded-lg border bg-muted/30 p-4">
        <AnalyzeButton
          interviewId={params.id}
          hasTranscript={hasTranscript}
          hasDraft={draft !== null}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <div className="space-y-6">
          {draft ? (
            <ScorecardDraftView draft={draft} />
          ) : (
            <section className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              {hasTranscript
                ? "No AI scorecard draft yet. Run analysis to generate the competency scores, summary, and recommendation."
                : "No transcript on this interview yet. Submit or transcribe a recording, then run analysis."}
            </section>
          )}

          <section className="space-y-1 rounded-lg border bg-muted/20 p-4">
            <h2 className="text-sm font-medium">Transcript</h2>
            <p className="text-xs text-muted-foreground">
              The interview transcript is stored encrypted and is never exposed to the
              browser. The only transcript-derived text shown here is the verbatim
              evidence quote attached to each competency score in the AI draft.
            </p>
          </section>
        </div>

        <aside className="space-y-6">
          <CalibrationFlags flags={flags} />

          {calibration && calibration.reviewerCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              Panel of {calibration.reviewerCount} reviewer
              {calibration.reviewerCount === 1 ? "" : "s"} ·{" "}
              {calibration.divergences.length} competenc
              {calibration.divergences.length === 1 ? "y" : "ies"} diverging &gt; 2 points.
            </p>
          ) : null}

          {scorecard ? (
            <ReviewerScorecardForm scorecard={scorecard} />
          ) : (
            <section className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              The reviewer scorecard becomes available once the interview has been analysed.
            </section>
          )}

          <section className="space-y-2 rounded-lg border p-4">
            <h2 className="text-sm font-medium">Transcript privacy</h2>
            <p className="text-xs text-muted-foreground">
              Transcripts are retained per org policy (default 90 days), then deleted. A
              candidate may request deletion at any time (DSAR); deletion also clears the
              transcript-derived evidence quotes from the AI draft.
            </p>
            <DeleteTranscriptControl interviewId={params.id} hasTranscript={hasTranscript} />
          </section>
        </aside>
      </div>
    </div>
  );
}

/**
 * Derive presentational SCORE_DIVERGENCE flags from the API-computed numeric
 * divergences (analyze step 4: "> 2 points on same competency → debrief"). The
 * numeric spread is authoritative; this just renders it alongside the AI flags.
 */
function divergenceFlags(calibration: PanelCalibration): CalibrationFlag[] {
  return calibration.divergences.map((d) => ({
    type: "SCORE_DIVERGENCE",
    severity: d.spread >= 3 ? "HIGH" : "MEDIUM",
    detail: `Panel scores diverge by ${d.spread} points on this competency (min ${d.minScore}, max ${d.maxScore}). Debrief recommended.`,
    evidenceQuote: null,
    illegalTopic: null,
    competencyId: d.competencyId,
  }));
}

/** Merge flag lists, deduping by (type · detail · competencyId · evidenceQuote). */
function mergeFlags(...lists: CalibrationFlag[][]): CalibrationFlag[] {
  const seen = new Set<string>();
  const out: CalibrationFlag[] = [];
  for (const list of lists) {
    for (const f of list) {
      const key = `${f.type}|${f.detail}|${f.competencyId ?? ""}|${f.evidenceQuote ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

function BackLink() {
  return (
    <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
      ← Back to jobs
    </Link>
  );
}

function ErrorCard({ err }: { err: unknown }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {err instanceof ApiClientError
        ? `${err.code}: ${err.message}`
        : "Failed to load interview. Is the API running on NEXT_PUBLIC_API_URL?"}
    </div>
  );
}
