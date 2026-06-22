import * as React from "react";

import { Collapsible } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { InterviewTranscript, SpeakerRole, TranscriptSegment } from "@peopleos/schemas";

/**
 * TranscriptView — a speaker-labelled, timestamped transcript (Module 3 output:
 * "timestamped transcript with speaker labels", produced by self-hosted WhisperX
 * with diarisation). Collapsed by default because it is long and highly
 * sensitive; the reviewer opens it on demand.
 *
 * Privacy: transcripts are stored ENCRYPTED (S3 SSE-KMS), never in plaintext,
 * and are decrypted server-side only for an authorised reviewer. This component
 * is presentational and never persists transcript text client-side.
 *
 * Typed off the frozen `InterviewTranscript` / `TranscriptSegment` contracts.
 */

const ROLE_LABEL: Record<SpeakerRole, string> = {
  INTERVIEWER: "Interviewer",
  CANDIDATE: "Candidate",
  UNKNOWN: "Unknown",
};

/** Role colour cue: candidate emphasised, interviewer muted, unknown neutral. */
const ROLE_CLASS: Record<SpeakerRole, string> = {
  INTERVIEWER: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  CANDIDATE: "border-green-600/40 bg-green-600/10 text-green-700",
  UNKNOWN: "border-input bg-muted/40 text-muted-foreground",
};

/** Format a seconds offset as m:ss (or h:mm:ss for long interviews). */
function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function TranscriptView({
  transcript,
  defaultOpen = false,
  className,
}: {
  transcript: InterviewTranscript;
  defaultOpen?: boolean;
  className?: string;
}) {
  const { segments, durationSec, language, source, diarised } = transcript;

  const meta = [
    `${segments.length} segment${segments.length === 1 ? "" : "s"}`,
    durationSec !== null ? formatDuration(durationSec) : null,
    SOURCE_LABEL[source],
    language ? language.toUpperCase() : null,
    diarised ? "diarised" : "not diarised",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className={cn("rounded-lg border", className)}>
      <div className="border-b px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Transcript</h2>
          <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Stored encrypted (S3 SSE-KMS), never in plaintext. Decrypted server-side
          for authorised review only; transcribed on self-hosted WhisperX.
        </p>
      </div>

      <div className="px-4 py-3">
        {segments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No transcript segments. The transcript may not have been processed yet,
            or it has been deleted (retention / DSAR).
          </p>
        ) : (
          <Collapsible
            summary="Show full transcript"
            count={segments.length}
            defaultOpen={defaultOpen}
          >
            <ol className="mt-2 space-y-3">
              {segments.map((segment, i) => (
                <Segment key={`${segment.startSec}-${i}`} segment={segment} />
              ))}
            </ol>
          </Collapsible>
        )}
      </div>
    </section>
  );
}

const SOURCE_LABEL: Record<InterviewTranscript["source"], string> = {
  ZOOM: "Zoom",
  GOOGLE_MEET: "Google Meet",
  MS_TEAMS: "MS Teams",
  UPLOAD: "Upload",
};

function Segment({ segment }: { segment: TranscriptSegment }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
      <span className="select-none pt-0.5 text-right text-xs tabular-nums text-muted-foreground">
        {formatTimestamp(segment.startSec)}
      </span>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
              ROLE_CLASS[segment.speakerRole],
            )}
          >
            {ROLE_LABEL[segment.speakerRole]}
          </span>
          {/* The raw diarisation label (e.g. "Interviewer A") when it differs. */}
          {segment.speakerLabel &&
          segment.speakerLabel.toLowerCase() !==
            ROLE_LABEL[segment.speakerRole].toLowerCase() ? (
            <span className="text-[10px] text-muted-foreground">{segment.speakerLabel}</span>
          ) : null}
        </div>
        <p className="text-sm leading-relaxed">{segment.text}</p>
      </div>
    </li>
  );
}
