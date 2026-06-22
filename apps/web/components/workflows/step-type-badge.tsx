import * as React from "react";

import { cn } from "@/lib/utils";
import type { StepType } from "@peopleos/schemas";

/**
 * StepTypeBadge — labels a workflow step's `StepType`. Auto steps
 * (NOTIFICATION / AI_TASK / BRANCH) run inline; human steps (TASK / APPROVAL /
 * TIMER) wait for a person (or a timer). The colour cue distinguishes the two
 * families so the step DAG and the task timeline read at a glance.
 */
const STEP_LABEL: Record<StepType, string> = {
  TASK: "Task",
  APPROVAL: "Approval",
  NOTIFICATION: "Notification",
  AI_TASK: "AI task",
  TIMER: "Timer",
  BRANCH: "Branch",
};

/** Human (waiting) steps vs auto (inline) steps — drives the colour family. */
const HUMAN_STEPS: ReadonlySet<StepType> = new Set<StepType>([
  "TASK",
  "APPROVAL",
  "TIMER",
]);

const STEP_CLASS: Record<StepType, string> = {
  TASK: "border-blue-600/40 bg-blue-600/10 text-blue-700",
  APPROVAL: "border-purple-600/40 bg-purple-600/10 text-purple-700",
  TIMER: "border-amber-600/40 bg-amber-600/10 text-amber-700",
  NOTIFICATION: "border-muted-foreground/30 bg-muted text-muted-foreground",
  AI_TASK: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
  BRANCH: "border-muted-foreground/30 bg-muted text-muted-foreground",
};

export function StepTypeBadge({
  type,
  className,
}: {
  type: StepType;
  className?: string;
}): React.ReactElement {
  const isHuman = HUMAN_STEPS.has(type);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        STEP_CLASS[type],
        className,
      )}
      title={isHuman ? "Human step (waits)" : "Automatic step (runs inline)"}
    >
      {STEP_LABEL[type]}
    </span>
  );
}

export { STEP_LABEL, HUMAN_STEPS };
