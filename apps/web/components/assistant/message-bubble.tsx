import * as React from "react";

import { ToolTrace } from "@/components/assistant/tool-trace";
import { cn } from "@/lib/utils";
import type { AssistantMessageRole, ToolCallTrace } from "@peopleos/schemas";

/**
 * MessageBubble — one turn in the PeopleOS Assistant conversation (Module 10).
 *
 * User turns are styled distinctly from assistant turns. An assistant turn
 * additionally renders the COLLAPSIBLE tool-call trace
 * (`ToolCallTrace` = tool · ok · summary) for the tools the agent ran — a summary
 * only, by contract; the raw, possibly-sensitive tool output never reaches the
 * client. Chain-of-thought reasoning (the agent's `<thinking>`) is stripped
 * server-side and is never part of `content`.
 *
 * Presentational: the conversation owns the data; this component is typed off the
 * frozen `AssistantMessageRole` / `ToolCallTrace` contracts only.
 */
export function MessageBubble({
  role,
  content,
  toolCalls = [],
  /** True while the agent runs (the assistant placeholder turn). */
  pending = false,
}: {
  role: AssistantMessageRole;
  content: string;
  toolCalls?: ToolCallTrace[];
  pending?: boolean;
}) {
  const isUser = role === "USER";

  return (
    <div
      className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border bg-muted/40 text-foreground",
        )}
      >
        {pending ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden
              className="inline-flex gap-0.5"
              role="presentation"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
            </span>
            <span>Working…</span>
          </span>
        ) : (
          <p className="whitespace-pre-wrap break-words">{content}</p>
        )}
      </div>

      {!isUser && !pending && toolCalls.length > 0 ? (
        <ToolTrace toolCalls={toolCalls} />
      ) : null}
    </div>
  );
}
