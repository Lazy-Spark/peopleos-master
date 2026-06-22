import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SuggestedActions — the assistant's role-aware next-step suggestions, rendered
 * as clickable chips (Module 10). Each `AssistantChatResponse.suggestedActions`
 * string is a ready-to-send follow-up; clicking a chip PREFILLS the input so the
 * user can edit before sending (it does not auto-send — the user stays in
 * control, and for write actions the agent still confirms intent server-side).
 *
 * The suggestions are computed server-side from the caller's trusted role, so the
 * chips a manager sees differ from an HRBP's — the client just renders whatever
 * the API returned. Presentational; no wire shapes are redeclared here.
 */
export function SuggestedActions({
  actions,
  onPick,
  disabled = false,
  className,
}: {
  actions: string[];
  /** Prefill the composer with the chosen suggestion (does not auto-send). */
  onPick: (action: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (actions.length === 0) return null;

  return (
    <div
      className={cn("flex flex-wrap gap-2", className)}
      aria-label="Suggested next steps"
    >
      {actions.map((action, i) => (
        <button
          key={`${i}-${action}`}
          type="button"
          disabled={disabled}
          onClick={() => onPick(action)}
          className={cn(
            "inline-flex items-center rounded-full border border-input bg-background px-3 py-1 text-xs text-foreground transition-colors",
            "hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {action}
        </button>
      ))}
    </div>
  );
}
