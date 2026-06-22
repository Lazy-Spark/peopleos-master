"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";

import { OutreachPanel } from "@/components/copilot/outreach-panel";
import { Button } from "@/components/ui/button";
import { Collapsible } from "@/components/ui/collapsible";
import { ScoreBar } from "@/components/ui/score-bar";
import { TierBadge } from "@/components/ui/tier-badge";
import { api, ApiClientError, type PipelineEntry } from "@/lib/api";
import type {
  ApplicationStage,
  CandidateRanking,
  RankingTier,
  RankJobResponse,
} from "@peopleos/schemas";

/**
 * Recruiter shortlist for a job. A "Screen all" action runs Module 1 batch
 * ranking (POST /api/v1/jobs/:id/rank), then the pipeline renders best-first
 * with a tier badge, final score, sub-score breakdown, and collapsible
 * explainability (strengths / concerns / interview focus + AI summary).
 *
 * Baseline ordering and content come from the compact `Application.aiRanking`
 * already stored on each row; a fresh `RankJobResponse` (when present) supplies
 * the richer per-candidate detail (sub-scores) and the authoritative order.
 *
 * Chain-of-thought reasoning is intentionally absent everywhere here: it is
 * audit-only and the API never returns it (CandidateRanking has no reasoning
 * field). The UI only shows the returned explainability.
 */
export function PipelineList({
  jobId,
  initialEntries,
}: {
  jobId: string;
  initialEntries: PipelineEntry[];
}) {
  const router = useRouter();

  // Fresh batch result (client-only until persisted). Keyed by candidateId in
  // `rankingsByCandidate` for per-row lookup; `skipped` explains omissions.
  const [batch, setBatch] = React.useState<RankJobResponse | null>(null);

  const screenAll = useMutation<RankJobResponse, Error>({
    mutationFn: () => api.rankJob(jobId),
    onSuccess: (data) => {
      setBatch(data);
      // Re-pull persisted rows (stage, compact aiRanking) from the server.
      router.refresh();
    },
  });

  const rankingsByCandidate = React.useMemo(() => {
    const map = new Map<string, CandidateRanking>();
    for (const r of batch?.rankings ?? []) map.set(r.candidateId, r);
    return map;
  }, [batch]);

  const skippedByCandidate = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const s of batch?.skipped ?? []) map.set(s.candidateId, s.reason);
    return map;
  }, [batch]);

  // Sort best-first. Use the fresh finalScore where available, otherwise the
  // compact stored score; candidates with neither sort last (stable by name).
  const sorted = React.useMemo(() => {
    const scoreOf = (entry: PipelineEntry): number | null => {
      const fresh = rankingsByCandidate.get(entry.candidate.id);
      if (fresh) return fresh.finalScore;
      return entry.application.aiRanking?.score ?? null;
    };
    return [...initialEntries].sort((a, b) => {
      const sa = scoreOf(a);
      const sb = scoreOf(b);
      if (sa === null && sb === null) {
        return (a.candidate.name ?? "").localeCompare(b.candidate.name ?? "");
      }
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sb - sa;
    });
  }, [initialEntries, rankingsByCandidate]);

  if (initialEntries.length === 0) {
    return <p className="text-sm text-muted-foreground">No applicants yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {sorted.length} candidate{sorted.length === 1 ? "" : "s"}
          {batch ? (
            <>
              {" · "}
              {batch.rankings.length} screened
              {batch.skipped.length > 0 ? `, ${batch.skipped.length} skipped` : ""}
            </>
          ) : null}
        </p>
        <Button
          size="sm"
          onClick={() => screenAll.mutate()}
          disabled={screenAll.isPending}
        >
          {screenAll.isPending ? "Screening…" : batch ? "Re-screen all" : "Screen all"}
        </Button>
      </div>

      {screenAll.isError ? (
        <p className="text-xs text-destructive">
          {screenAll.error instanceof ApiClientError
            ? `${screenAll.error.code}: ${screenAll.error.message}`
            : screenAll.error.message}
        </p>
      ) : null}

      <ol className="space-y-3">
        {sorted.map((entry, index) => (
          <PipelineRow
            key={entry.application.id}
            entry={entry}
            rank={index + 1}
            freshRanking={rankingsByCandidate.get(entry.candidate.id) ?? null}
            skippedReason={skippedByCandidate.get(entry.candidate.id) ?? null}
            onStageChanged={() => router.refresh()}
          />
        ))}
      </ol>
    </div>
  );
}

/** The four configurable composite weights (spec Module 1 step 5). */
const COMPONENT_META: ReadonlyArray<{
  key: keyof CandidateRanking["components"];
  label: string;
  weight: string;
}> = [
  { key: "skillMatch", label: "Skill match", weight: "×0.35" },
  { key: "expRelevance", label: "Experience relevance", weight: "×0.30" },
  { key: "holisticScore", label: "Holistic", weight: "×0.25" },
  { key: "yoeMatch", label: "Years of experience", weight: "×0.10" },
];

function PipelineRow({
  entry,
  rank,
  freshRanking,
  skippedReason,
  onStageChanged,
}: {
  entry: PipelineEntry;
  rank: number;
  freshRanking: CandidateRanking | null;
  skippedReason: string | null;
  onStageChanged: () => void;
}) {
  const { application, candidate } = entry;
  const compact = application.aiRanking;

  // Prefer the fresh, richer ranking; fall back to the compact stored summary.
  const tier: RankingTier | null = freshRanking?.tier ?? compact?.tier ?? null;
  const finalScore: number | null =
    freshRanking?.finalScore ?? compact?.score ?? null;
  const summary: string | null = freshRanking?.aiSummary ?? compact?.summary ?? null;
  const strengths = freshRanking?.strengths ?? compact?.strengths ?? [];
  const concerns = freshRanking?.concerns ?? compact?.concerns ?? [];
  const interviewFocus =
    freshRanking?.interviewFocus ?? compact?.interviewFocus ?? [];

  const stageMutation = useMutation({
    mutationFn: (stage: ApplicationStage) =>
      api.updateApplicationStage(application.id, stage),
    onSuccess: onStageChanged,
  });

  const isTerminal =
    application.stage === "REJECTED" ||
    application.stage === "WITHDRAWN" ||
    application.stage === "HIRED";

  return (
    <li className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-sm font-semibold tabular-nums text-muted-foreground">
            #{rank}
          </span>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <p className="font-medium">{candidate.name ?? "Unnamed candidate"}</p>
              {tier ? <TierBadge tier={tier} /> : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {candidate.email ?? "no email"} · stage {application.stage}
              {finalScore !== null ? (
                <>
                  {" · "}
                  <span className="font-medium text-foreground tabular-nums">
                    {Math.round(finalScore * 100)}
                  </span>
                  <span className="text-muted-foreground">/100</span>
                </>
              ) : null}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => stageMutation.mutate("INTERVIEW")}
            disabled={stageMutation.isPending || isTerminal}
          >
            Advance
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => stageMutation.mutate("REJECTED")}
            disabled={stageMutation.isPending || application.stage === "REJECTED"}
          >
            Reject
          </Button>
        </div>
      </div>

      {stageMutation.isError ? (
        <p className="mt-3 text-xs text-destructive">
          {stageMutation.error instanceof ApiClientError
            ? `${stageMutation.error.code}: ${stageMutation.error.message}`
            : stageMutation.error instanceof Error
              ? stageMutation.error.message
              : "Failed to update stage."}
        </p>
      ) : null}

      {skippedReason ? (
        <p className="mt-3 rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-2 text-xs text-amber-700">
          Skipped during screening: {skippedReason}
        </p>
      ) : null}

      {/* Sub-score breakdown — only the fresh ranking carries component scores. */}
      {freshRanking ? (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2">
          {COMPONENT_META.map(({ key, label, weight }) => (
            <ScoreBar
              key={key}
              label={label}
              weight={weight}
              value={freshRanking.components[key]}
            />
          ))}
        </div>
      ) : null}

      {summary || strengths.length > 0 || concerns.length > 0 || interviewFocus.length > 0 ? (
        <div className="mt-3 space-y-2 border-t pt-3">
          {summary ? (
            <p className="text-sm text-muted-foreground">{summary}</p>
          ) : null}
          {strengths.length > 0 ? (
            <Collapsible summary="Strengths" count={strengths.length} defaultOpen>
              <FactList items={strengths} />
            </Collapsible>
          ) : null}
          {concerns.length > 0 ? (
            <Collapsible summary="Concerns" count={concerns.length}>
              <FactList items={concerns} />
            </Collapsible>
          ) : null}
          {interviewFocus.length > 0 ? (
            <Collapsible summary="Interview focus" count={interviewFocus.length}>
              <FactList items={interviewFocus} />
            </Collapsible>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
          Not yet screened. Run “Screen all” to rank this candidate.
        </p>
      )}

      {/* Module 2b — Candidate Outreach. Personalised to the real candidate
          (not masked, unlike scoring); each variant is copyable. Disabled on
          terminal stages where outreach no longer applies. */}
      {!isTerminal ? (
        <div className="mt-3 border-t pt-3">
          <OutreachPanel applicationId={application.id} />
        </div>
      ) : null}
    </li>
  );
}

function FactList({ items }: { items: string[] }) {
  return (
    <ul className="ml-4 list-disc text-xs text-muted-foreground">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
