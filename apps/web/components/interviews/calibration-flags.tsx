import * as React from "react";

import { cn } from "@/lib/utils";
import type {
  CalibrationFlag,
  CalibrationFlagType,
  FlagSeverity,
  IllegalTopic,
} from "@peopleos/schemas";

/**
 * CalibrationFlags — renders the interviewer calibration nudges (Module 3
 * analyze step 4). Three flag types from the frozen `CalibrationFlag` contract:
 *
 *  - ILLEGAL_QUESTION — off-limits / illegal topics (pregnancy, religion, age,
 *    nationality, …). A COMPLIANCE RISK, so it is rendered PROMINENTLY with
 *    HIGH-severity alert styling and an explicit "immediate review" call.
 *  - LEADING_QUESTION — the interviewer led the candidate to an answer.
 *  - SCORE_DIVERGENCE — panel scores diverge > 2 points on a competency
 *    (API-computed): "debrief needed".
 *
 * Illegal-question flags are surfaced first and visually escalated regardless of
 * the model's severity. Typed off the frozen contracts — no local shapes.
 */

const ILLEGAL_TOPIC_LABEL: Record<IllegalTopic, string> = {
  PREGNANCY: "Pregnancy",
  FAMILY_PLANNING: "Family planning",
  RELIGION: "Religion",
  AGE: "Age",
  NATIONALITY: "Nationality",
  MARITAL_STATUS: "Marital status",
  HEALTH_DISABILITY: "Health / disability",
  RACE: "Race",
  SEXUAL_ORIENTATION: "Sexual orientation",
  OTHER: "Other off-limits topic",
};

const TYPE_LABEL: Record<CalibrationFlagType, string> = {
  ILLEGAL_QUESTION: "Illegal / off-limits question",
  LEADING_QUESTION: "Leading question",
  SCORE_DIVERGENCE: "Score divergence",
};

const SEVERITY_LABEL: Record<FlagSeverity, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
};

/** Per-severity card styling; illegal questions force HIGH styling below. */
const SEVERITY_CARD: Record<FlagSeverity, string> = {
  LOW: "border-input bg-muted/40 text-foreground",
  MEDIUM: "border-amber-600/40 bg-amber-600/10 text-amber-800",
  HIGH: "border-destructive/50 bg-destructive/10 text-destructive",
};

const SEVERITY_PILL: Record<FlagSeverity, string> = {
  LOW: "border-input bg-background text-muted-foreground",
  MEDIUM: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  HIGH: "border-destructive/50 bg-destructive/10 text-destructive",
};

export function CalibrationFlags({
  flags,
  className,
}: {
  flags: CalibrationFlag[];
  className?: string;
}) {
  // Surface illegal questions first (compliance risk), then leading questions,
  // then score divergence; within a group, HIGH severity first.
  const sorted = React.useMemo(() => {
    const typeRank: Record<CalibrationFlagType, number> = {
      ILLEGAL_QUESTION: 0,
      LEADING_QUESTION: 1,
      SCORE_DIVERGENCE: 2,
    };
    const sevRank: Record<FlagSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return [...flags].sort(
      (a, b) =>
        typeRank[a.type] - typeRank[b.type] || sevRank[a.severity] - sevRank[b.severity],
    );
  }, [flags]);

  const illegalCount = flags.filter((f) => f.type === "ILLEGAL_QUESTION").length;

  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">Calibration</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {flags.length} flag{flags.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Compliance banner: illegal-question flags are escalated to the top. */}
      {illegalCount > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
        >
          {illegalCount} potentially illegal / off-limits question
          {illegalCount === 1 ? "" : "s"} detected — compliance review required.
        </div>
      ) : null}

      {flags.length === 0 ? (
        <p className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-xs text-green-700">
          No calibration issues detected — no leading or illegal questions, and no
          panel score divergence above threshold.
        </p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((flag, i) => (
            <FlagCard key={`${flag.type}-${i}`} flag={flag} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FlagCard({ flag }: { flag: CalibrationFlag }) {
  // Illegal questions are a compliance risk: render at HIGH styling regardless
  // of the model-assigned severity.
  const isIllegal = flag.type === "ILLEGAL_QUESTION";
  const effectiveSeverity: FlagSeverity = isIllegal ? "HIGH" : flag.severity;

  return (
    <li className={cn("rounded-md border px-3 py-2", SEVERITY_CARD[effectiveSeverity])}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">
          {TYPE_LABEL[flag.type]}
          {isIllegal && flag.illegalTopic ? (
            <span className="font-normal"> · {ILLEGAL_TOPIC_LABEL[flag.illegalTopic]}</span>
          ) : null}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
            SEVERITY_PILL[effectiveSeverity],
          )}
        >
          {SEVERITY_LABEL[effectiveSeverity]}
        </span>
        {flag.type === "SCORE_DIVERGENCE" && flag.competencyId ? (
          <span className="text-[10px] text-muted-foreground">
            competency {flag.competencyId}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs leading-relaxed text-foreground">{flag.detail}</p>

      {/* For leading/illegal flags the grounding transcript quote is shown. */}
      {flag.evidenceQuote ? (
        <blockquote className="mt-1.5 border-l-2 border-muted-foreground/40 pl-2 text-xs italic text-muted-foreground">
          “{flag.evidenceQuote}”
        </blockquote>
      ) : null}
    </li>
  );
}
