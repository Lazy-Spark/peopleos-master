"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { ChartSpecView } from "@/components/analytics/chart-spec-view";
import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AskDataResponse } from "@peopleos/schemas";

/**
 * AskYourData — the "Ask your data" NL query interface (Module 5e).
 *
 * The employee types a natural-language question (e.g. "how many ML engineers do
 * we have in Europe?"); `api.askAnalytics(question)` posts only the question
 * (the frozen `AskDataApiRequest`). The API supplies the tenant-scoped metrics
 * snapshot and the AI answers grounded ONLY in those metrics — never inventing
 * numbers, never generating SQL. The response renders:
 *   - the `answer` text,
 *   - the `usedMetrics` keys it drew on (transparency),
 *   - an optional `chart` spec via Recharts (BAR/LINE/PIE),
 *   - and a `confidence` badge.
 */

const SUGGESTIONS = [
  "How many engineers do we have by level?",
  "What is our offer acceptance rate?",
  "Which managers have the widest spans of control?",
];

const CONFIDENCE_PILL: Record<AskDataResponse["confidence"], string> = {
  high: "border-green-600/40 bg-green-600/10 text-green-700",
  medium: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  low: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function AskYourData({ className }: { className?: string }) {
  const [question, setQuestion] = React.useState("");
  const [asked, setAsked] = React.useState<string | null>(null);

  const ask = useMutation<AskDataResponse, Error, string>({
    mutationFn: (q) => api.askAnalytics(q),
  });

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending) return;
    setAsked(trimmed);
    ask.mutate(trimmed);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit(question);
  };

  return (
    <div className={cn("rounded-lg border bg-card p-5", className)}>
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Ask your data
        </p>
        <p className="text-sm text-muted-foreground">
          Ask a question about your workforce in plain English. Answers are
          grounded only in your computed metrics — no numbers are invented.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. How many engineers do we have in Europe?"
          aria-label="Ask your workforce data a question"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <Button type="submit" disabled={ask.isPending || question.trim() === ""}>
          {ask.isPending ? "Asking…" : "Ask"}
        </Button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setQuestion(s);
              submit(s);
            }}
            disabled={ask.isPending}
            className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      {ask.isError ? (
        <p className="mt-3 text-sm text-destructive">
          {ask.error instanceof ApiClientError
            ? `${ask.error.code}: ${ask.error.message}`
            : ask.error.message}
        </p>
      ) : null}

      {ask.data ? (
        <div className="mt-4 space-y-3 rounded-md border bg-background p-4">
          {asked ? (
            <p className="text-xs italic text-muted-foreground">“{asked}”</p>
          ) : null}

          <div className="flex items-start justify-between gap-3">
            <p className="text-sm leading-relaxed text-foreground">
              {ask.data.answer}
            </p>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                CONFIDENCE_PILL[ask.data.confidence],
              )}
              title="Model self-reported confidence"
            >
              {ask.data.confidence}
            </span>
          </div>

          {ask.data.chart ? <ChartSpecView chart={ask.data.chart} /> : null}

          {ask.data.usedMetrics.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
              <span className="text-[11px] text-muted-foreground">Based on:</span>
              {ask.data.usedMetrics.map((m) => (
                <span
                  key={m}
                  className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {m}
                </span>
              ))}
            </div>
          ) : null}

          <p className="text-[10px] text-muted-foreground">
            Answered by {ask.data.modelVersion} · grounded in your metrics (no SQL
            generated)
          </p>
        </div>
      ) : null}
    </div>
  );
}
