import * as React from "react";

import { cn } from "@/lib/utils";
import {
  confidencePct,
  isVerifiedSource,
  PROFICIENCY_LABEL,
  SOURCE_LABEL,
} from "@/components/skills/skill-display";
import type { ProficiencyLevel, SkillSource } from "@peopleos/schemas";

/**
 * SkillBadge — one skill assertion rendered as a chip: skill name, proficiency,
 * and a CONFIDENCE INDICATOR sized + coloured by the `confidenceScore` (spec 6a:
 * skills "sized by proficiency confidence"). Confidence is always source-derived
 * server-side (`confidenceForSource`); this component only visualises it.
 *
 * The dot's diameter scales with confidence (low ≈ 6px → high ≈ 12px) and its
 * colour ramps amber → emerald, so a verified, high-confidence skill reads as a
 * larger green dot and a thin self-report as a small amber one. The numeric
 * percentage and the source are surfaced for screen readers + on hover.
 */

/** Confidence [0,1] → a Tailwind dot colour (amber → emerald ramp). */
function confidenceColor(score: number): string {
  if (score >= 0.85) return "bg-emerald-500";
  if (score >= 0.7) return "bg-green-500";
  if (score >= 0.55) return "bg-yellow-500";
  return "bg-amber-500";
}

/** Confidence [0,1] → dot diameter in px (6 → 12), so size encodes trust. */
function confidenceSizePx(score: number): number {
  const clamped = Math.min(1, Math.max(0, score));
  return Math.round(6 + clamped * 6);
}

export function ConfidenceDot({
  score,
  source,
  className,
}: {
  score: number;
  source: SkillSource;
  className?: string;
}) {
  const size = confidenceSizePx(score);
  const label = `${confidencePct(score)} confidence · ${SOURCE_LABEL[source]}`;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center", className)}
      title={label}
      role="img"
      aria-label={label}
    >
      <span
        aria-hidden
        className={cn("inline-block rounded-full", confidenceColor(score))}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

export function SkillBadge({
  name,
  proficiency,
  confidenceScore,
  source,
  className,
}: {
  name: string;
  proficiency: ProficiencyLevel;
  confidenceScore: number;
  source: SkillSource;
  className?: string;
}) {
  const verified = isVerifiedSource(source);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm",
        verified ? "border-emerald-600/40" : "border-input",
        className,
      )}
    >
      <ConfidenceDot score={confidenceScore} source={source} />
      <span className="font-medium text-foreground">{name}</span>
      <span className="text-xs text-muted-foreground">
        {PROFICIENCY_LABEL[proficiency]}
      </span>
      {verified ? (
        <span
          className="text-[10px] font-medium uppercase tracking-wide text-emerald-700"
          title={SOURCE_LABEL[source]}
        >
          ✓
        </span>
      ) : null}
    </span>
  );
}
