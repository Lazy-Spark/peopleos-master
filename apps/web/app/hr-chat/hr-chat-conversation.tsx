"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { ChatBubble } from "@/components/hr-chat/chat-bubble";
import { Button } from "@/components/ui/button";
import { api, ApiClientError, type AskHrChatInput } from "@/lib/api";
import type { AskResponse, ChatFeedback, Citation } from "@peopleos/schemas";

/**
 * Module 4 — Employee HR Assistant conversation.
 *
 * A chat UI over the company knowledge base. Each turn calls `api.askHrChat`,
 * which (server-side) does hybrid retrieval over the org's policy chunks, has
 * Claude generate an answer grounded ONLY in those chunks, and escalates to a
 * human when the answer isn't in policy, confidence is low, or the topic is
 * sensitive (termination, harassment, salary dispute).
 *
 * The component:
 *   - maintains the `sessionId` across turns (the API returns it on the first
 *     answer; we pass it back on every subsequent ask to keep memory);
 *   - renders each assistant answer WITH its citations (policy title + section +
 *     effective date + "View full policy"), an escalation banner + HR ticket id
 *     when escalated, and thumbs up/down feedback per answer;
 *   - records feedback via `api.sendChatFeedback`, keyed by the message id.
 *
 * All wire shapes come from `@peopleos/schemas`; nothing is redeclared here.
 */

/** A rendered conversation turn. Assistant turns carry the answer metadata. */
type RenderedTurn = {
  role: "user" | "assistant";
  content: string;
  /** Persisted message id (assistant turns only) — gates feedback. */
  messageId?: string;
  citations?: Citation[];
  escalated?: boolean;
  ticketId?: string | null;
  feedback?: ChatFeedback | null;
};

export function HrChatConversation() {
  const [turns, setTurns] = React.useState<RenderedTurn[]>([]);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [input, setInput] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);

  const ask = useMutation<AskResponse, Error, AskHrChatInput>({
    mutationFn: (payload) => api.askHrChat(payload),
    onSuccess: (res) => {
      // Pin the session so the next turn continues the same conversation.
      setSessionId(res.sessionId);
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.answer,
          messageId: res.messageId,
          citations: res.citations,
          escalated: res.escalated,
          ticketId: res.ticketId,
          feedback: null,
        },
      ]);
    },
  });

  const feedback = useMutation<
    void,
    Error,
    { messageId: string; feedback: ChatFeedback }
  >({
    mutationFn: ({ messageId, feedback }) =>
      api.sendChatFeedback(messageId, feedback),
    onSuccess: (_void, { messageId, feedback }) => {
      // Optimistically reflect the recorded vote on the relevant turn.
      setTurns((prev) =>
        prev.map((turn) =>
          turn.messageId === messageId ? { ...turn, feedback } : turn,
        ),
      );
    },
  });

  // Keep the newest turn in view as the conversation grows.
  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, ask.isPending]);

  const send = () => {
    const message = input.trim();
    if (!message || ask.isPending) return;
    setTurns((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    ask.mutate({ message, sessionId });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onFeedback = (messageId: string, value: ChatFeedback) => {
    feedback.mutate({ messageId, feedback: value });
  };

  return (
    <div className="flex flex-col rounded-lg border">
      <div
        ref={listRef}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
        style={{ minHeight: "24rem", maxHeight: "32rem" }}
      >
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-muted-foreground">
              Ask me anything about your company&apos;s policies — PTO, benefits,
              parental leave, code of conduct, and more.
            </p>
            <p className="max-w-md text-xs text-muted-foreground">
              I answer only from your company&apos;s published policies and always
              cite the source. For sensitive matters (e.g. termination, harassment,
              or a pay dispute) I&apos;ll connect you with a human HR Business
              Partner.
            </p>
          </div>
        ) : (
          turns.map((turn, i) => (
            <ChatBubble
              key={turn.messageId ?? `${turn.role}-${i}`}
              role={turn.role}
              content={turn.content}
              citations={turn.citations}
              escalated={turn.escalated}
              ticketId={turn.ticketId}
              messageId={turn.messageId}
              feedback={turn.feedback}
              onFeedback={onFeedback}
              feedbackPending={feedback.isPending}
            />
          ))
        )}

        {ask.isPending ? (
          <p className="text-xs text-muted-foreground">
            Checking your company policies…
          </p>
        ) : null}

        {ask.isError ? (
          <p className="text-xs text-destructive">
            {ask.error instanceof ApiClientError
              ? `${ask.error.code}: ${ask.error.message}`
              : ask.error.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-2 border-t p-3">
        <textarea
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about a policy…"
          aria-label="Ask the HR Assistant"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            Answers are grounded in company policy and cited. Not legal advice.
          </p>
          <Button
            size="sm"
            onClick={send}
            disabled={ask.isPending || input.trim() === ""}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
