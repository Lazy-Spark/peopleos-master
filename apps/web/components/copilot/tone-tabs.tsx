"use client";

import * as React from "react";

import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import type { OutreachTone, OutreachVariant } from "@peopleos/schemas";

/**
 * ToneTabs — tabbed view of the three outreach tone variants (Module 2b:
 * warm / formal / brief, generated for A/B testing). Each tab shows the
 * variant's subject + body, each independently copyable.
 *
 * Typed off the frozen `OutreachVariant` / `OutreachTone` contracts.
 */

const TONE_LABEL: Record<OutreachTone, string> = {
  WARM: "Warm",
  FORMAL: "Formal",
  BRIEF: "Brief",
};

export function ToneTabs({
  variants,
  className,
}: {
  variants: OutreachVariant[];
  className?: string;
}) {
  const [active, setActive] = React.useState(0);

  if (variants.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No tone variants generated.</p>
    );
  }

  // Guard against the active index drifting out of range across re-renders.
  const index = Math.min(active, variants.length - 1);
  const current = variants[index]!;

  return (
    <div className={cn("space-y-3", className)}>
      <div
        role="tablist"
        aria-label="Outreach tone variants"
        className="flex flex-wrap gap-1 rounded-md border bg-muted/40 p-1"
      >
        {variants.map((variant, i) => {
          const selected = i === index;
          return (
            <button
              key={variant.tone}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(i)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                selected
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {TONE_LABEL[variant.tone]}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" className="space-y-3">
        <CopyableField label="Subject" value={current.subject} />
        <CopyableField label="Body" value={current.body} multiline />
      </div>
    </div>
  );
}

/**
 * CopyableField — a labelled, read-only block of generated text with a copy
 * action. Shared building block for outreach subjects/bodies and the InMail.
 */
export function CopyableField({
  label,
  value,
  multiline = false,
  className,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <p
        className={cn(
          "rounded-md border bg-muted/40 px-3 py-2 text-sm",
          multiline ? "whitespace-pre-wrap" : "truncate",
        )}
      >
        {value}
      </p>
    </div>
  );
}
