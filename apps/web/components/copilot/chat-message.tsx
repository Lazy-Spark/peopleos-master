import * as React from "react";

import { cn } from "@/lib/utils";
import type { ChatRole, ChatToolInvocation } from "@peopleos/schemas";

/**
 * ChatMessage — one turn in the Recruiter Chat Assistant (Module 2c). User and
 * assistant turns are styled distinctly; an assistant turn may carry a compact
 * tool trace (tool · ok · resultSummary) from the LangGraph ReAct agent.
 *
 * Typed off the frozen `ChatRole` / `ChatToolInvocation` contracts. The trace is
 * a summary only by contract — no raw data dumps are ever sent over the wire.
 */
export function ChatMessage({
  role,
  content,
  toolTrace,
}: {
  role: ChatRole;
  content: string;
  /** Present only on assistant turns that invoked agent tools. */
  toolTrace?: ChatToolInvocation[];
}) {
  const isUser = role === "user";

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border bg-muted/40 text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{content}</p>
      </div>

      {!isUser && toolTrace && toolTrace.length > 0 ? (
        <ToolTrace trace={toolTrace} />
      ) : null}
    </div>
  );
}

/**
 * ToolTrace — compact render of the agent's tool invocations. Each row shows the
 * tool name, an ok/failed status dot, and the (nullable) result summary.
 */
export function ToolTrace({
  trace,
  className,
}: {
  trace: ChatToolInvocation[];
  className?: string;
}) {
  return (
    <ul
      className={cn("w-full max-w-[85%] space-y-1", className)}
      aria-label="Agent tool trace"
    >
      {trace.map((invocation, i) => (
        <li
          key={`${invocation.tool}-${i}`}
          className="flex items-start gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs"
        >
          <span
            aria-hidden
            className={cn(
              "mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
              invocation.ok ? "bg-green-600" : "bg-destructive",
            )}
          />
          <span className="space-y-0.5">
            <span className="flex items-center gap-1.5">
              <code className="font-mono font-medium text-foreground">
                {invocation.tool}
              </code>
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wide",
                  invocation.ok ? "text-green-700" : "text-destructive",
                )}
              >
                {invocation.ok ? "ok" : "failed"}
              </span>
            </span>
            {invocation.resultSummary ? (
              <span className="block text-muted-foreground">
                {invocation.resultSummary}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
