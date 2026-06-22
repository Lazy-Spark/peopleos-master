"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/api";
import type {
  IngestPolicyRequest,
  IngestPolicyResponse,
  PolicyDocType,
} from "@peopleos/schemas";

/**
 * PolicyUploadForm — HRBP/ADMIN uploads a company policy into the knowledge base
 * (Module 4 / Layer 2C ingest). The author supplies title, document type,
 * effective date, and the policy body (rawText for dev; prod uses a file upload
 * → fileUrl). `api.ingestPolicy` runs the document pipeline server-side
 * (structural parse → semantic chunking → embed + index → SimHash dedup) and
 * returns the persisted `PolicyDocument` + the indexed `chunkCount`.
 *
 * The submitted body conforms to the frozen `IngestPolicyRequest` — exactly one
 * of rawText / fileUrl (this form uses rawText). On success it invalidates the
 * policies list query so the new document appears, and shows the chunk count.
 */

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Document-type options — values are the frozen `PolicyDocType` enum. */
const DOC_TYPE_OPTIONS: ReadonlyArray<{ value: PolicyDocType; label: string }> = [
  { value: "HANDBOOK", label: "Employee handbook" },
  { value: "BENEFITS", label: "Benefits" },
  { value: "PTO", label: "Time off (PTO)" },
  { value: "CONDUCT", label: "Code of conduct" },
  { value: "SECURITY", label: "Security" },
  { value: "COMPENSATION", label: "Compensation" },
  { value: "CAREER_LADDER", label: "Career ladder" },
  { value: "OTHER", label: "Other" },
];

export function PolicyUploadForm() {
  const queryClient = useQueryClient();

  const [title, setTitle] = React.useState("");
  const [docType, setDocType] = React.useState<PolicyDocType>("HANDBOOK");
  const [effectiveDate, setEffectiveDate] = React.useState("");
  const [rawText, setRawText] = React.useState("");

  const ingest = useMutation<IngestPolicyResponse, Error, IngestPolicyRequest>({
    mutationFn: (input) => api.ingestPolicy(input),
    onSuccess: () => {
      // Refresh the policies list so the freshly ingested doc shows up.
      void queryClient.invalidateQueries({ queryKey: ["policies"] });
      // Keep the result (chunk count) on screen, but clear the body for the
      // next upload.
      setTitle("");
      setEffectiveDate("");
      setRawText("");
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedText = rawText.trim();
    if (!trimmedTitle || !trimmedText) return;
    ingest.mutate({
      title: trimmedTitle,
      docType,
      effectiveDate: effectiveDate || null,
      rawText: trimmedText,
    });
  };

  const canSubmit =
    title.trim() !== "" && rawText.trim() !== "" && !ingest.isPending;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="policy-title" className="text-sm font-medium">
            Title <span className="text-destructive">*</span>
          </label>
          <input
            id="policy-title"
            className={fieldClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="2026 Employee Handbook"
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="policy-doctype" className="text-sm font-medium">
            Document type
          </label>
          <select
            id="policy-doctype"
            className={fieldClass}
            value={docType}
            onChange={(e) => setDocType(e.target.value as PolicyDocType)}
          >
            {DOC_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="policy-effective" className="text-sm font-medium">
            Effective date
          </label>
          <input
            id="policy-effective"
            type="date"
            className={fieldClass}
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="policy-text" className="text-sm font-medium">
          Policy text <span className="text-destructive">*</span>
        </label>
        <textarea
          id="policy-text"
          className={fieldClass}
          rows={10}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder="Paste the full policy text. It is segmented by section, semantically chunked, embedded, and indexed for the HR Assistant to cite."
          required
        />
        <p className="text-xs text-muted-foreground">
          Dev path: paste the raw text. In production HRBPs upload a file (PDF /
          DOCX) and the pipeline extracts the text server-side.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canSubmit}>
          {ingest.isPending ? "Ingesting…" : "Ingest policy"}
        </Button>

        {ingest.isSuccess ? (
          <p className="text-xs text-green-700">
            Ingested “{ingest.data.document.title}” (v{ingest.data.document.version}) —{" "}
            <span className="font-medium tabular-nums">
              {ingest.data.chunkCount} chunk{ingest.data.chunkCount === 1 ? "" : "s"}
            </span>{" "}
            indexed
            {ingest.data.supersededDocumentId
              ? " · superseded a prior version"
              : null}
            .
          </p>
        ) : null}

        {ingest.isError ? (
          <p className="text-xs text-destructive">
            {ingest.error instanceof ApiClientError
              ? `${ingest.error.code}: ${ingest.error.message}`
              : ingest.error.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
