"use client";

import * as React from "react";

import { MessageBubble } from "@/components/assistant/message-bubble";
import { SuggestedActions } from "@/components/assistant/suggested-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AssistantMessageRole, ToolCallTrace } from "@peopleos/schemas";

/**
 * A rendered conversation turn. Assistant turns carry the summarised tool trace;
 * the in-flight assistant turn is marked `pending` (shown as a working bubble).
 *
 * Typed off the frozen `AssistantMessageRole` / `ToolCallTrace` contracts — no
 * wire shapes are redeclared.
 */
export type AssistantTurn = {
  role: AssistantMessageRole;
  content: string;
  toolCalls?: ToolCallTrace[];
  pending?: boolean;
};

/**
 * AssistantThread — the PeopleOS Assistant chat surface (Module 10).
 *
 * Renders the conversation (user + assistant turns, each assistant turn with its
 * collapsible tool trace), an optimistic user bubble + a "working" assistant
 * bubble while the agent runs, the role-aware `suggestedActions` chips (which
 * prefill the composer), and the input box. Send is disabled while a turn is
 * in flight so the conversation order stays correct.
 *
 * Presentational + controlled: the page owns the conversation state, the
 * `assistantChat` mutation, and the session id; this component raises `onSend`
 * with the typed message. No data fetching happens here.
 */
export function AssistantThread({
  turns,
  suggestedActions,
  onSend,
  pending,
  error,
  className,
}: {
  turns: AssistantTurn[];
  /** The latest assistant turn's role-aware next-step suggestions. */
  suggestedActions: string[];
  onSend: (message: string) => void;
  pending: boolean;
  error?: string | null;
  className?: string;
}) {
  const [input, setInput] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  // Keep the newest turn in view as the conversation grows.
  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, pending]);

  const send = () => {
    const message = input.trim();
    if (!message || pending) return;
    onSend(message);
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Clicking a suggested-action chip PREFILLS the composer (it does not auto-send),
  // so the user can edit before sending — write actions still confirm intent.
  const prefill = (action: string) => {
    setInput(action);
    inputRef.current?.focus();
  };

  return (
    <div className={cn("flex flex-col rounded-lg border", className)}>
      <div
        ref={listRef}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
        style={{ minHeight: "26rem", maxHeight: "34rem" }}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="PeopleOS Assistant conversation"
      >
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-muted-foreground">
              I&apos;m your PeopleOS Assistant. Ask me to pull analytics, check
              skills, look at attrition, find internal candidates, draft a job
              description, raise an HR ticket, and more.
            </p>
            <p className="max-w-md text-xs text-muted-foreground">
              I only ever do what your role allows — every action is governed and
              tenant-scoped server-side, and I&apos;ll confirm before any write
              (raising a ticket, starting a workflow, sending outreach).
            </p>
          </div>
        ) : (
          turns.map((turn, i) => (
            <MessageBubble
              key={i}
              role={turn.role}
              content={turn.content}
              toolCalls={turn.toolCalls}
              pending={turn.pending}
            />
          ))
        )}

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      {suggestedActions.length > 0 && !pending ? (
        <div className="border-t px-3 py-2.5">
          <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Suggested
          </p>
          <SuggestedActions actions={suggestedActions} onPick={prefill} />
        </div>
      ) : null}

      <div className="space-y-2 border-t p-3">
        <textarea
          ref={inputRef}
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask the PeopleOS Assistant…"
          aria-label="Message the PeopleOS Assistant"
          maxLength={8000}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            Role-aware and governed. I confirm before any write action.
          </p>
          <Button size="sm" onClick={send} disabled={pending || input.trim() === ""}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
