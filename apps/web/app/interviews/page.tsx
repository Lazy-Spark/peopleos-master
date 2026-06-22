/**
 * Interviews index (Module 3). The full interview list / scheduling surface is
 * out of scope for this skeleton — interviews are reached by id at
 * `/interviews/[id]` (e.g. from a candidate's pipeline row in a fuller app).
 * This stub documents the entry point and the privacy posture.
 */
export default function InterviewsIndexPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Interviews</h1>
        <p className="text-sm text-muted-foreground">
          Interview Intelligence &amp; Summaries (Module 3). Open a specific
          interview at <code className="rounded bg-muted px-1 py-0.5">/interviews/&lt;id&gt;</code>{" "}
          to review the speaker-labelled transcript, the AI scorecard draft, the
          calibration flags, and to submit your scorecard.
        </p>
      </section>

      <section className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
        <h2 className="text-sm font-medium text-foreground">Privacy</h2>
        <ul className="ml-4 mt-2 list-disc space-y-1">
          <li>
            Candidate <span className="font-medium">consent</span> is required before
            any recording or processing (enforced at interview creation).
          </li>
          <li>
            Transcripts are stored <span className="font-medium">encrypted</span> (S3
            SSE-KMS), never in plaintext, and transcribed on self-hosted WhisperX.
          </li>
          <li>
            Transcripts are <span className="font-medium">retained</span> per org
            policy (default 90 days), then deleted; deletion is available on demand
            (DSAR).
          </li>
        </ul>
      </section>
    </div>
  );
}
