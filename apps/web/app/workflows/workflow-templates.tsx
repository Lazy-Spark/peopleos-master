"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Collapsible } from "@/components/ui/collapsible";
import { StepList } from "@/components/workflows/step-list";
import { api, ApiClientError } from "@/lib/api";
import type {
  DraftWorkflowResponse,
  WorkflowDefinition,
} from "@peopleos/schemas";

/**
 * WorkflowTemplates (Module 9, client) — the templates / definitions list, the
 * "draft from description" box, and the start action.
 *
 * - Definitions are read live (`api.listWorkflowDefinitions`); each renders its
 *   trigger + step DAG (`StepList`) and a Start button that creates an instance
 *   (`api.startWorkflow`) and routes to the monitor for that instance.
 * - The draft box sends only a natural-language `description`
 *   (`api.draftWorkflow`); the API fills `orgId` + `orgContext` server-side and
 *   returns a proposed step DAG with a confidence level, rendered read-only for
 *   review. The draft is ADVISORY — it is not persisted here.
 */
export function WorkflowTemplates() {
  const definitions = useQuery<WorkflowDefinition[], Error>({
    queryKey: ["workflows", "definitions"],
    queryFn: () => api.listWorkflowDefinitions(),
  });

  return (
    <div className="space-y-8">
      <DraftBox />

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Templates</h2>
        {definitions.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading templates…</p>
        ) : definitions.isError || !definitions.data ? (
          <ErrorBox error={definitions.error} what="templates" />
        ) : definitions.data.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No workflow templates yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {definitions.data.map((def) => (
              <DefinitionRow key={def.id} definition={def} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DefinitionRow({ definition }: { definition: WorkflowDefinition }) {
  const router = useRouter();

  const start = useMutation({
    mutationFn: () => api.startWorkflow(definition.id, {}),
    onSuccess: (instance) => {
      router.push(`/workflows/${instance.id}`);
    },
  });

  const triggerLabel =
    definition.trigger === "EVENT"
      ? `Event: ${definition.eventType ?? "—"}`
      : definition.trigger === "SCHEDULED"
        ? `Scheduled: ${definition.schedule ?? "—"}`
        : "Manual";

  return (
    <li className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{definition.name}</p>
            {!definition.active ? (
              <span className="rounded-full border border-muted-foreground/30 bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Inactive
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">{definition.key}</code> · v
            {definition.version} · {triggerLabel} · {definition.steps.length}{" "}
            step{definition.steps.length === 1 ? "" : "s"}
          </p>
          {definition.description ? (
            <p className="text-sm text-muted-foreground">
              {definition.description}
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          onClick={() => start.mutate()}
          disabled={start.isPending || !definition.active}
          title={
            definition.trigger === "EVENT"
              ? "This template normally starts from an event; starting manually creates an instance now."
              : undefined
          }
        >
          {start.isPending ? "Starting…" : "Start"}
        </Button>
      </div>

      <div className="mt-3 border-t pt-3">
        <Collapsible summary="Steps" count={definition.steps.length}>
          <StepList steps={definition.steps} className="mt-2" />
        </Collapsible>
      </div>

      {start.isError ? (
        <div className="mt-2">
          <ErrorBox error={start.error} what="instance" />
        </div>
      ) : null}
    </li>
  );
}

function DraftBox() {
  const [description, setDescription] = React.useState("");

  const draft = useMutation<DraftWorkflowResponse, Error, string>({
    mutationFn: (desc: string) => api.draftWorkflow(desc),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const desc = description.trim();
    if (desc) draft.mutate(desc);
  };

  return (
    <section className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Draft a workflow with AI</h2>
        <p className="text-sm text-muted-foreground">
          Describe an HR process in plain language and the assistant proposes a
          step DAG you can review. The draft is advisory — nothing is created
          until a person confirms it.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-2">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='e.g. "When an offer is accepted, provision IT, schedule a day-1 orientation, and remind the manager at 30/60/90 days."'
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="sm" disabled={draft.isPending || !description.trim()}>
          {draft.isPending ? "Drafting…" : "Draft workflow"}
        </Button>
      </form>

      {draft.isError ? <ErrorBox error={draft.error} what="draft" /> : null}

      {draft.data ? <DraftResult draft={draft.data} /> : null}
    </section>
  );
}

function DraftResult({ draft }: { draft: DraftWorkflowResponse }) {
  const triggerLabel =
    draft.trigger === "EVENT"
      ? `Event: ${draft.eventType ?? "—"}`
      : draft.trigger;

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{draft.name}</p>
        <span className="text-xs text-muted-foreground">
          {triggerLabel} · confidence {draft.confidence} · {draft.modelVersion}
          {draft.promptVersion ? ` · ${draft.promptVersion}` : ""}
        </span>
      </div>
      <StepList steps={draft.steps} />
      <p className="text-xs text-muted-foreground">
        Proposed steps — review and adjust before creating this as a template.
      </p>
    </div>
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
