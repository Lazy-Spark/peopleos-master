"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { GigCard } from "@/components/mobility/gig-card";
import { api, ApiClientError } from "@/lib/api";
import type {
  CreateGigRequest,
  Gig,
  RecommendedGigs,
} from "@peopleos/schemas";

/**
 * GigMarketplace (8c, client) — recommended gigs + browse + post-a-gig.
 *
 * "Recommended for you" gigs are skill-graph matched (`api.getRecommendedGigs`)
 * and carry a `matchScore` + matched / missing breakdown; the browse list shows
 * every open gig. Expressing interest (in `GigCard`) acts on the employee's OWN
 * behalf — the API resolves the acting employee from the session, so the card
 * only POSTs the gig id. The employee in context is read from `?employee=` in
 * this dev foundation. The post-a-gig form sends only the frozen
 * `CreateGigRequest`; `orgId` + the creator are resolved server-side.
 */
export function GigMarketplace() {
  const searchParams = useSearchParams();
  const employeeId = searchParams.get("employee") ?? "";
  const queryClient = useQueryClient();

  const recommended = useQuery<RecommendedGigs, Error>({
    queryKey: ["mobility", "recommended-gigs", employeeId],
    queryFn: () => api.getRecommendedGigs(employeeId),
    enabled: employeeId !== "",
  });

  const gigs = useQuery<Gig[], Error>({
    queryKey: ["mobility", "gigs"],
    queryFn: () => api.listGigs(),
  });

  const refreshGigs = () => {
    void queryClient.invalidateQueries({ queryKey: ["mobility", "gigs"] });
    if (employeeId !== "") {
      void queryClient.invalidateQueries({
        queryKey: ["mobility", "recommended-gigs", employeeId],
      });
    }
  };

  return (
    <div className="space-y-8">
      {/* ── Recommended for you ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Recommended for you</h2>
        {employeeId === "" ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Append <code>?employee=&lt;your-employee-id&gt;</code> to see gigs
            matched to your skills.
          </p>
        ) : recommended.isLoading ? (
          <p className="text-sm text-muted-foreground">Finding matched gigs…</p>
        ) : recommended.isError || !recommended.data ? (
          <ErrorBox error={recommended.error} what="recommended gigs" />
        ) : recommended.data.gigs.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No matched gigs yet.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {recommended.data.gigs.map((g) => (
              <GigCard
                key={g.gigId}
                gigId={g.gigId}
                title={g.title}
                requiredSkills={[]}
                durationWeeks={g.durationWeeks}
                match={{
                  score: g.matchScore,
                  matchedSkills: g.matchedSkills,
                  missingSkills: g.missingSkills,
                }}
                canExpressInterest={employeeId !== ""}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Browse all gigs ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Browse gigs</h2>
        {gigs.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading gigs…</p>
        ) : gigs.isError || !gigs.data ? (
          <ErrorBox error={gigs.error} what="gigs" />
        ) : gigs.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No gigs posted yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {gigs.data.map((g) => (
              <GigCard
                key={g.id}
                gigId={g.id}
                title={g.title}
                description={g.description}
                requiredSkills={g.requiredSkills}
                durationWeeks={g.durationWeeks}
                status={g.status}
                canExpressInterest={employeeId !== ""}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Post a gig (manager / HRBP) ───────────────────────────────────── */}
      <PostGigForm onCreated={refreshGigs} />
    </div>
  );
}

function PostGigForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [skillsRaw, setSkillsRaw] = React.useState("");
  const [durationWeeks, setDurationWeeks] = React.useState("");

  const create = useMutation<Gig, Error, CreateGigRequest>({
    mutationFn: (input) => api.createGig(input),
    onSuccess: () => {
      setTitle("");
      setDescription("");
      setSkillsRaw("");
      setDurationWeeks("");
      onCreated();
    },
  });

  const canSubmit = title.trim().length > 0 && description.trim().length > 0;

  const submit = () => {
    const requiredSkills = skillsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const parsedDuration = durationWeeks.trim() === "" ? null : Number(durationWeeks);
    create.mutate({
      title: title.trim(),
      description: description.trim(),
      requiredSkills,
      durationWeeks:
        parsedDuration !== null && Number.isFinite(parsedDuration) && parsedDuration > 0
          ? Math.floor(parsedDuration)
          : null,
    });
  };

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-lg font-medium">Post a gig</h2>
        <p className="text-xs text-muted-foreground">
          Manager / HRBP — a short stretch assignment. Comma-separate required
          skills.
        </p>
      </div>

      <div className="grid gap-3">
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Title (e.g. Lead a 6-week analytics sprint)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Required skills (comma-separated)"
            value={skillsRaw}
            onChange={(e) => setSkillsRaw(e.target.value)}
          />
          <input
            type="number"
            min={1}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Duration (weeks, optional)"
            value={durationWeeks}
            onChange={(e) => setDurationWeeks(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={!canSubmit || create.isPending}>
          {create.isPending ? "Posting…" : "Post gig"}
        </Button>
        {create.isSuccess ? (
          <span className="text-xs text-emerald-700">Gig posted.</span>
        ) : null}
      </div>

      {create.isError ? <ErrorBox error={create.error} what="gig" /> : null}
    </section>
  );
}

function ErrorBox({ error, what }: { error: Error | null; what: string }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {error instanceof ApiClientError
        ? `${error.code}: ${error.message}`
        : `Could not load ${what}. Is the API running on NEXT_PUBLIC_API_URL?`}
    </div>
  );
}
