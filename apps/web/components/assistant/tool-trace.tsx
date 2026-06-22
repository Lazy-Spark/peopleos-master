import * as React from "react";

import { Collapsible } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolCallTrace } from "@peopleos/schemas";

/**
 * ToolTrace — the COLLAPSIBLE record of the tools the agent ran on one assistant
 * turn (Module 10). The summary line reads e.g. "Used: get_attrition_summary,
 * get_skill_inventory"; expanding it shows each tool with an ok/failed status dot
 * and its non-sensitive `summary`.
 *
 * Transparency without leakage: by contract the trace is a SUMMARY only
 * (`ToolCallTrace` = tool · ok · summary) — the raw, possibly-sensitive tool
 * output never crosses the wire, so there is nothing here to redact. A failed
 * tool (`ok: false`, e.g. a role-disallowed tool the dispatcher refused) is shown
 * so the user can see the agent's governance boundary was enforced, not hidden.
 *
 * Presentational; typed off the frozen `ToolCallTrace` contract only.
 */
export function ToolTrace({
  toolCalls,
  className,
}: {
  toolCalls: ToolCallTrace[];
  className?: string;
}) {
  if (toolCalls.length === 0) return null;

  // The summary label lists the tool names the agent used, deduped + in order.
  const usedLabel = `Used: ${dedupe(toolCalls.map((t) => t.tool)).join(", ")}`;

  return (
    <div className={cn("w-full max-w-[85%]", className)}>
      <Collapsible summary={usedLabel} count={toolCalls.length}>
        <ul className="space-y-1" aria-label="Agent tool trace">
          {toolCalls.map((call, i) => (
            <li
              key={`${call.tool}-${i}`}
              className="flex items-start gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs"
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                  call.ok ? "bg-green-600" : "bg-destructive",
                )}
              />
              <span className="space-y-0.5">
                <span className="flex items-center gap-1.5">
                  <code className="font-mono font-medium text-foreground">
                    {call.tool}
                  </code>
                  <span
                    className={cn(
                      "text-[10px] uppercase tracking-wide",
                      call.ok ? "text-green-700" : "text-destructive",
                    )}
                  >
                    {call.ok ? "ok" : "refused"}
                  </span>
                </span>
                {call.summary ? (
                  <span className="block text-muted-foreground">
                    {call.summary}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </Collapsible>
    </div>
  );
}

/** Stable-order de-duplication of the tool names for the summary label. */
function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
