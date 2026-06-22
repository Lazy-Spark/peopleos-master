import * as React from "react";

import { cn } from "@/lib/utils";
import { StepTypeBadge } from "./step-type-badge";
import type { BranchCondition, BranchOp, WorkflowStep } from "@peopleos/schemas";

/**
 * StepList — renders a workflow's step DAG (a `WorkflowStep[]`). Used both for a
 * stored `WorkflowDefinition.steps` and for an AI `DraftWorkflowResponse.steps`,
 * so it takes the bare array. Each row shows the step type, name, owning role,
 * SLA, the default `next` edge, and — for BRANCH steps — the ordered, SAFE
 * declarative rules (field/op/value → next). The branch predicate is rendered
 * read-only; it is never evaluated client-side (the engine evaluates it
 * server-side over `instance.context`, never via eval).
 *
 * `currentStepId` (optional) highlights the instance's current step when this
 * list is shown alongside a running instance.
 */
const OP_LABEL: Record<BranchOp, string> = {
  EQ: "=",
  NE: "≠",
  EXISTS: "exists",
  GT: ">",
  LT: "<",
};

function formatCondition(c: BranchCondition): string {
  if (c.op === "EXISTS") return `${c.field} exists`;
  const value =
    c.value === undefined
      ? "—"
      : c.value === null
        ? "null"
        : typeof c.value === "string"
          ? `"${c.value}"`
          : String(c.value);
  return `${c.field} ${OP_LABEL[c.op]} ${value}`;
}

export function StepList({
  steps,
  currentStepId,
  className,
}: {
  steps: WorkflowStep[];
  currentStepId?: string | null;
  className?: string;
}): React.ReactElement {
  if (steps.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
        No steps defined.
      </p>
    );
  }

  return (
    <ol className={cn("space-y-2", className)}>
      {steps.map((step, i) => {
        const isCurrent = currentStepId != null && step.id === currentStepId;
        return (
          <li
            key={step.id}
            className={cn(
              "rounded-lg border p-3",
              isCurrent && "border-blue-600/50 bg-blue-600/5 ring-1 ring-blue-600/20",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">
                {i + 1}.
              </span>
              <StepTypeBadge type={step.type} />
              <span className="font-medium">{step.name}</span>
              {isCurrent ? (
                <span className="text-xs font-medium text-blue-700">
                  ← current
                </span>
              ) : null}
            </div>

            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {step.assigneeRole ? (
                <div>
                  <dt className="inline">Owner: </dt>
                  <dd className="inline text-foreground">{step.assigneeRole}</dd>
                </div>
              ) : null}
              {step.slaHours ? (
                <div>
                  <dt className="inline">SLA: </dt>
                  <dd className="inline text-foreground">{step.slaHours}h</dd>
                </div>
              ) : null}
              {step.next ? (
                <div>
                  <dt className="inline">Next: </dt>
                  <dd className="inline text-foreground">{step.next}</dd>
                </div>
              ) : !step.branches || step.branches.length === 0 ? (
                <div className="text-foreground">Terminal step</div>
              ) : null}
            </dl>

            {step.branches && step.branches.length > 0 ? (
              <ul className="mt-2 space-y-1 border-t pt-2 text-xs">
                {step.branches.map((rule, ri) => (
                  <li key={ri} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground">
                      {ri === 0 ? "if" : "else if"}
                    </span>
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                      {formatCondition(rule.when)}
                    </code>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium text-foreground">{rule.next}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
