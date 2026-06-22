"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { PolicyUploadForm } from "@/components/policies/policy-upload-form";
import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PolicyDocType, PolicyDocument, PolicyStatus } from "@peopleos/schemas";

/**
 * Module 4 / Layer 2C — Policy knowledge base management (HRBP/ADMIN).
 *
 * Composes the upload form (`PolicyUploadForm` → `api.ingestPolicy`) with a
 * live list of the org's policy documents (`api.listPolicies`). Each row shows
 * title / type / version / status / effective date and an Archive action
 * (`api.deletePolicy`, soft-archive → status ARCHIVED, chunks deactivated so the
 * chatbot stops retrieving from it). The upload form and archive both invalidate
 * the shared `["policies"]` query so the list stays current.
 *
 * Typed entirely off `@peopleos/schemas`.
 */

const DOC_TYPE_LABEL: Record<PolicyDocType, string> = {
  HANDBOOK: "Handbook",
  BENEFITS: "Benefits",
  PTO: "PTO",
  CONDUCT: "Conduct",
  SECURITY: "Security",
  COMPENSATION: "Compensation",
  CAREER_LADDER: "Career ladder",
  OTHER: "Other",
};

const STATUS_PILL: Record<PolicyStatus, string> = {
  ACTIVE: "border-green-600/40 bg-green-600/10 text-green-700",
  SUPERSEDED: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  ARCHIVED: "border-input bg-muted text-muted-foreground",
};

export function PoliciesManager() {
  const policies = useQuery({
    queryKey: ["policies"],
    queryFn: () => api.listPolicies(),
  });

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Upload a policy</h2>
        <p className="text-sm text-muted-foreground">
          Add a policy document to the knowledge base. It is parsed, semantically
          chunked, embedded, and indexed so the Employee HR Assistant can answer
          from it and cite the source.
        </p>
        <PolicyUploadForm />
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Policy documents</h2>
          {policies.data ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {policies.data.length} document{policies.data.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        {policies.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading policies…</p>
        ) : policies.isError ? (
          <p className="text-sm text-destructive">
            {policies.error instanceof ApiClientError
              ? `${policies.error.code}: ${policies.error.message}`
              : "Could not load policies. Is the API running?"}
          </p>
        ) : policies.data && policies.data.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {policies.data.map((policy) => (
              <PolicyRow key={policy.id} policy={policy} />
            ))}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No policies yet. Upload one above to seed the HR Assistant&apos;s
            knowledge base.
          </div>
        )}
      </section>
    </div>
  );
}

function PolicyRow({ policy }: { policy: PolicyDocument }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);

  const archive = useMutation<PolicyDocument, Error>({
    mutationFn: () => api.deletePolicy(policy.id),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["policies"] });
    },
  });

  const isArchived = policy.status === "ARCHIVED";

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{policy.title}</span>
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              STATUS_PILL[policy.status],
            )}
          >
            {policy.status}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {DOC_TYPE_LABEL[policy.docType]} · v{policy.version}
          {policy.effectiveDate ? ` · effective ${policy.effectiveDate}` : ""}
          {policy.chunksIndexedAt ? " · indexed" : " · not yet indexed"}
        </p>
      </div>

      <div className="flex items-center gap-2">
        {isArchived ? (
          <span className="text-xs text-muted-foreground">Archived</span>
        ) : !confirming ? (
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={() => setConfirming(true)}
          >
            Archive
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => archive.mutate()}
              disabled={archive.isPending}
            >
              {archive.isPending ? "Archiving…" : "Confirm"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={archive.isPending}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>

      {archive.isError ? (
        <p className="w-full text-xs text-destructive">
          {archive.error instanceof ApiClientError
            ? `${archive.error.code}: ${archive.error.message}`
            : archive.error.message}
        </p>
      ) : null}
    </li>
  );
}
