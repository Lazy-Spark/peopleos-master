import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AssistantSessionSummary } from "@peopleos/schemas";

/**
 * SessionList — the assistant's history sidebar (Module 10). Lists the caller's
 * OWN sessions (`AssistantSessionSummary` = id + title + updatedAt), newest-first,
 * with a "New chat" action and the active session highlighted. The list is scoped
 * to the authenticated caller server-side, so a user only ever sees their own
 * conversations.
 *
 * Presentational: the page owns the data (`api.listAssistantSessions`) and the
 * selection state; this component is typed off the frozen
 * `AssistantSessionSummary` contract only.
 */
export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNewChat,
  loading = false,
  error = false,
  onRetry,
  className,
}: {
  sessions: AssistantSessionSummary[];
  /** The session currently open (null for an unsaved new chat). */
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  loading?: boolean;
  /** The history fetch failed — show a distinct error (not an empty state). */
  error?: boolean;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <aside
      className={cn("flex flex-col rounded-lg border", className)}
      aria-label="Assistant history"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <h2 className="text-sm font-medium">History</h2>
        <Button size="sm" variant="outline" onClick={onNewChat}>
          New chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Loading your sessions…
          </p>
        ) : error ? (
          <div className="px-2 py-3" role="alert">
            <p className="text-xs text-destructive">
              Couldn&apos;t load your conversations.
            </p>
            {onRetry ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onRetry}
                className="mt-2"
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No conversations yet. Start a new chat to ask the assistant anything.
          </p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/60",
                    )}
                  >
                    <span className="block truncate font-medium">
                      {session.title ?? "Untitled conversation"}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {formatUpdatedAt(session.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** Render the ISO `updatedAt` as a short, locale-aware date-time label. */
function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
