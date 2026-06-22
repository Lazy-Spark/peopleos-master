import * as React from "react";

import { BiasCheckNote } from "@/components/copilot/inclusive-flag-list";
import { StarBars } from "@/components/interviews/star-bars";
import { Collapsible } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type {
  AiScorecardDraft,
  CompetencyEvidence,
  CompetencyScore,
  Confidence,
  ScorecardRecommendation,
} from "@peopleos/schemas";

/**
 * ScorecardDraftView — the AI scorecard draft (Module 3 analyze steps 2 & 3),
 * rendered as ADVISORY. For each competency: the 1-5 score, the verbatim
 * transcript `evidenceQuote` (prompt standard #2 — no score without evidence),
 * and the rationale. Plus the overall recommendation, confidence, keyReasons,
 * the 3-paragraph executive summary, and the bias-check envelope (standard #4).
 *
 * Optional per-answer `CompetencyEvidence` (analyze step 1: question / answer
 * summary / behavioural indicators / STAR completeness) is shown as collapsible
 * drill-down beneath the overview.
 *
 * Typed off the frozen `AiScorecardDraft` / `CompetencyEvidence` contracts. The
 * draft never moves a candidate on its own — the reviewer decides (see the
 * reviewer form). Chain-of-thought is audit-only and never on the wire.
 */

const RECOMMENDATION_LABEL: Record<ScorecardRecommendation, string> = {
  STRONG_YES: "Strong yes",
  YES: "Yes",
  NO: "No",
  STRONG_NO: "Strong no",
};

const RECOMMENDATION_CLASS: Record<ScorecardRecommendation, string> = {
  STRONG_YES: "border-green-600/40 bg-green-600/10 text-green-700",
  YES: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  NO: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  STRONG_NO: "border-destructive/40 bg-destructive/10 text-destructive",
};

const CONFIDENCE_CLASS: Record<Confidence, string> = {
  high: "border-green-600/40 bg-green-600/10 text-green-700",
  medium: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  low: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function ScorecardDraftView({
  draft,
  evidence = [],
  className,
}: {
  draft: AiScorecardDraft;
  /** Optional per-answer competency/STAR evidence (analyze step 1). */
  evidence?: CompetencyEvidence[];
  className?: string;
}) {
  return (
    <section className={cn("space-y-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">
          AI scorecard draft
          <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
            advisory — the reviewer decides
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
              RECOMMENDATION_CLASS[draft.overallRecommendation],
            )}
          >
            {RECOMMENDATION_LABEL[draft.overallRecommendation]}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              CONFIDENCE_CLASS[draft.confidence],
            )}
            title="Model confidence in this recommendation"
          >
            {draft.confidence} confidence
          </span>
        </div>
      </div>

      {/* Per-competency: 1-5 score + verbatim evidence quote + rationale. */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Competencies</h3>
        {draft.competencyScores.length === 0 ? (
          <p className="text-xs text-muted-foreground">No competency scores in the draft.</p>
        ) : (
          <ul className="space-y-3">
            {draft.competencyScores.map((cs) => (
              <CompetencyCard key={cs.competencyId} score={cs} />
            ))}
          </ul>
        )}
      </div>

      {/* Key reasons behind the overall recommendation. */}
      {draft.keyReasons.length > 0 ? (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Key reasons</h3>
          <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
            {draft.keyReasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The 3-paragraph executive summary (background, highlights, concerns). */}
      <div className="space-y-1.5">
        <h3 className="text-sm font-medium">Summary</h3>
        <div className="space-y-2 rounded-md border bg-muted/40 px-3 py-2.5 text-sm leading-relaxed text-foreground">
          {splitParagraphs(draft.summary).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      </div>

      {/* Per-answer competency / STAR drill-down (analyze step 1). */}
      {evidence.length > 0 ? (
        <div className="space-y-1.5">
          <Collapsible summary="Per-answer evidence (STAR)" count={evidence.length}>
            <ul className="mt-2 space-y-3">
              {evidence.map((ev, i) => (
                <EvidenceCard key={i} evidence={ev} />
              ))}
            </ul>
          </Collapsible>
        </div>
      ) : null}

      {/* Bias-check envelope on every HR-facing AI output (prompt standard #4). */}
      <BiasCheckNote
        biasIndicatorsDetected={draft.biasCheck.biasIndicatorsDetected}
        correctionApplied={draft.biasCheck.correctionApplied}
      />
    </section>
  );
}

/** Split the summary into paragraphs (the contract is a 3-paragraph summary). */
function splitParagraphs(text: string): string[] {
  const parts = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function ScorePill({ score }: { score: number }) {
  // 1-5 score; colour cue runs red (1) → green (5).
  const tone =
    score >= 4
      ? "border-green-600/40 bg-green-600/10 text-green-700"
      : score === 3
        ? "border-blue-600/40 bg-blue-600/10 text-blue-700"
        : score === 2
          ? "border-amber-600/40 bg-amber-600/10 text-amber-700"
          : "border-destructive/40 bg-destructive/10 text-destructive";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums",
        tone,
      )}
      aria-label={`Score ${score} out of 5`}
    >
      {score}/5
    </span>
  );
}

function CompetencyCard({ score }: { score: CompetencyScore }) {
  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{score.competencyName}</p>
        <ScorePill score={score.score} />
      </div>
      {/* Verbatim transcript evidence — required for every score (standard #2). */}
      {score.evidenceQuote ? (
        <blockquote className="mt-2 border-l-2 border-muted-foreground/30 pl-2 text-xs italic text-muted-foreground">
          “{score.evidenceQuote}”
        </blockquote>
      ) : null}
      <p className="mt-2 text-xs leading-relaxed text-foreground">{score.rationale}</p>
    </li>
  );
}

function EvidenceCard({ evidence }: { evidence: CompetencyEvidence }) {
  return (
    <li className="rounded-lg border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {evidence.competencyArea}
      </p>
      {evidence.question ? (
        <p className="mt-1 text-sm font-medium">{evidence.question}</p>
      ) : null}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {evidence.answerSummary}
      </p>
      {evidence.behaviouralIndicators.length > 0 ? (
        <ul className="ml-4 mt-1.5 list-disc text-xs text-muted-foreground">
          {evidence.behaviouralIndicators.map((bi, i) => (
            <li key={i}>{bi}</li>
          ))}
        </ul>
      ) : null}
      <StarBars
        className="mt-3"
        star={evidence.star}
        completeness={evidence.starCompleteness}
      />
    </li>
  );
}
