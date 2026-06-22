"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  BuildVsBuyRecommendation,
  BuildVsBuyResponse,
} from "@peopleos/schemas";

/**
 * BuildVsBuyButton — Module 6c "Build vs Buy" recommender for a gapped skill.
 *
 * On click, calls `api.recommendBuildVsBuy(skillId)`: the API assembles the
 * frozen `BuildVsBuyRequest` server-side (current supply, demand, and how many
 * employees are 1-2 skills away — trainable internally) and asks the AI service
 * whether to BUILD (train), BUY (hire), or HYBRID, with a rationale. The
 * recommendation is advisory (never an autonomous people decision).
 */

const REC_PILL: Record<BuildVsBuyRecommendation, string> = {
  BUILD: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
  BUY: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  HYBRID: "border-violet-600/40 bg-violet-600/10 text-violet-700",
};

const REC_LABEL: Record<BuildVsBuyRecommendation, string> = {
  BUILD: "Build (train)",
  BUY: "Buy (hire)",
  HYBRID: "Hybrid",
};

export function BuildVsBuyButton({ skillId }: { skillId: string }) {
  const rec = useMutation<BuildVsBuyResponse, Error>({
    mutationFn: () => api.recommendBuildVsBuy(skillId),
  });

  if (rec.data) {
    return (
      <div className="space-y-1">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
            REC_PILL[rec.data.recommendation],
          )}
        >
          {REC_LABEL[rec.data.recommendation]}
        </span>
        <p className="max-w-xs text-xs text-muted-foreground">
          {rec.data.rationale}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={() => rec.mutate()}
        disabled={rec.isPending}
      >
        {rec.isPending ? "Analysing…" : "Build vs buy"}
      </Button>
      {rec.isError ? (
        <span className="text-xs text-destructive">
          {rec.error instanceof ApiClientError
            ? `${rec.error.code}: ${rec.error.message}`
            : rec.error.message}
        </span>
      ) : null}
    </div>
  );
}
