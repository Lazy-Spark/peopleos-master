import { JdWriter } from "./jd-writer";

/**
 * Module 2a — JD Writer route. The page is a thin shell; the interactive form +
 * generated-JD render live in the `JdWriter` client component (it owns the
 * `api.writeJd` mutation and result state).
 */
export default function JdWriterPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">JD Writer</h1>
        <p className="text-sm text-muted-foreground">
          Generate an inclusive, tone-matched job description from a short brief.
          The recruiter always reviews and edits the draft — the flags are
          advisory.
        </p>
      </div>
      <JdWriter />
    </div>
  );
}
