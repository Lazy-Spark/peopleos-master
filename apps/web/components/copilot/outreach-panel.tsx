"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { BiasCheckNote } from "@/components/copilot/inclusive-flag-list";
import { CopyableField, ToneTabs } from "@/components/copilot/tone-tabs";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { api, ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { OutreachResult } from "@peopleos/schemas";

/**
 * Module 2b — Candidate Outreach panel, rendered inline on a pipeline row.
 *
 * A "Draft outreach" button calls `api.outreach(applicationId)`; the result is
 * shown as three tone variants (tabs: warm / formal / brief), a LinkedIn InMail,
 * and extra subject-line A/B-test options — each independently copyable — plus
 * the bias-check envelope (prompt standard #4).
 *
 * Bias note (per contract): outreach IS personalised to the real candidate, so
 * the profile is NOT masked (unlike Module 1 scoring). It references concrete
 * resume details by design to feel human.
 */
export function OutreachPanel({
  applicationId,
  className,
}: {
  applicationId: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  const outreach = useMutation<OutreachResult, Error>({
    mutationFn: () => api.outreach(applicationId),
    onSuccess: () => setOpen(true),
  });

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (outreach.data) {
              setOpen((v) => !v);
            } else {
              outreach.mutate();
            }
          }}
          disabled={outreach.isPending}
        >
          {outreach.isPending
            ? "Drafting…"
            : outreach.data
              ? open
                ? "Hide outreach"
                : "Show outreach"
              : "Draft outreach"}
        </Button>
        {outreach.data ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => outreach.mutate()}
            disabled={outreach.isPending}
          >
            Regenerate
          </Button>
        ) : null}
      </div>

      {outreach.isError ? (
        <p className="text-xs text-destructive">
          {outreach.error instanceof ApiClientError
            ? `${outreach.error.code}: ${outreach.error.message}`
            : outreach.error.message}
        </p>
      ) : null}

      {open && outreach.data ? <OutreachResultView result={outreach.data} /> : null}
    </div>
  );
}

function OutreachResultView({ result }: { result: OutreachResult }) {
  return (
    <div className="space-y-4 rounded-md border bg-muted/20 p-3">
      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Email variants
        </h4>
        <ToneTabs variants={result.variants} />
      </section>

      <section className="space-y-2 border-t pt-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          LinkedIn InMail
        </h4>
        {result.inMail.subject ? (
          <CopyableField label="Subject" value={result.inMail.subject} />
        ) : null}
        <CopyableField label="Body" value={result.inMail.body} multiline />
      </section>

      {result.subjectVariants.length > 0 ? (
        <section className="space-y-2 border-t pt-3">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Subject lines (A/B)
          </h4>
          <ul className="space-y-1.5">
            {result.subjectVariants.map((subject, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">{subject}</span>
                <CopyButton value={subject} label="Copy" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="border-t pt-3">
        <BiasCheckNote
          biasIndicatorsDetected={result.biasCheck.biasIndicatorsDetected}
          correctionApplied={result.biasCheck.correctionApplied}
        />
        <p className="mt-2 text-[10px] text-muted-foreground">
          {result.modelVersion}
          {result.promptVersion ? ` · prompt ${result.promptVersion}` : null}
        </p>
      </div>
    </div>
  );
}
