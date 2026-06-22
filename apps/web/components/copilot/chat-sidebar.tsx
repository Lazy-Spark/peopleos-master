"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { ChatMessage } from "@/components/copilot/chat-message";
import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ChatToolInvocation, ChatTurn, RecruiterChatResponse } from "@peopleos/schemas";

/**
 * Module 2c — Recruiter Chat Assistant sidebar, embedded in the job pipeline
 * view. A message list + input call `api.copilotChat(conversation, jobId)`; the
 * assistant's answer is appended along with a compact tool trace
 * (tool · ok · resultSummary) from the LangGraph ReAct agent.
 *
 * Simple non-streamed request/response (sufficient for this skeleton — the spec
 * notes SSE streaming for production). The full conversation is sent each turn
 * so the agent has context; `jobId` scopes it to the role the recruiter views.
 */

/** A rendered turn: the contract `ChatTurn` plus an optional assistant trace. */
type RenderedTurn = ChatTurn & { toolTrace?: ChatToolInvocation[] };

export function ChatSidebar({
  jobId,
  jobTitle,
  className,
}: {
  jobId: string;
  jobTitle: string;
  className?: string;
}) {
  const [turns, setTurns] = React.useState<RenderedTurn[]>([]);
  const [input, setInput] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);

  const chat = useMutation<RecruiterChatResponse, Error, ChatTurn[]>({
    mutationFn: (messages) => api.copilotChat(messages, jobId),
    onSuccess: (res) => {
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: res.answer, toolTrace: res.toolTrace },
      ]);
    },
  });

  // Keep the latest turn in view as the conversation grows.
  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, chat.isPending]);

  const send = () => {
    const content = input.trim();
    if (!content || chat.isPending) return;

    // Build the wire conversation from prior turns + this new user message.
    const wire: ChatTurn[] = [
      ...turns.map(({ role, content }) => ({ role, content })),
      { role: "user", content },
    ];
    setTurns((prev) => [...prev, { role: "user", content }]);
    setInput("");
    chat.mutate(wire);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <aside
      className={cn("flex flex-col rounded-lg border", className)}
      aria-label="Recruiter Copilot chat"
    >
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium">Copilot</h2>
        <p className="text-xs text-muted-foreground">
          Ask about this pipeline — <span className="truncate">{jobTitle}</span>
        </p>
      </div>

      <div
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
        // Bounded height so the sidebar scrolls independently of the page.
        style={{ maxHeight: "28rem" }}
      >
        {turns.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Try: “What’s the average time-to-offer for this role?” or “Find 5
            candidates in our pool who could fit.”
          </p>
        ) : (
          turns.map((turn, i) => (
            <ChatMessage
              key={i}
              role={turn.role}
              content={turn.content}
              toolTrace={turn.toolTrace}
            />
          ))
        )}

        {chat.isPending ? (
          <p className="text-xs text-muted-foreground">Copilot is thinking…</p>
        ) : null}

        {chat.isError ? (
          <p className="text-xs text-destructive">
            {chat.error instanceof ApiClientError
              ? `${chat.error.code}: ${chat.error.message}`
              : chat.error.message}
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
          placeholder="Ask the Copilot…"
          aria-label="Message Copilot"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={send}
            disabled={chat.isPending || input.trim() === ""}
          >
            Send
          </Button>
        </div>
      </div>
    </aside>
  );
}
