"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { AssistantThread, type AssistantTurn } from "@/components/assistant/assistant-thread";
import { SessionList } from "@/components/assistant/session-list";
import { api, ApiClientError } from "@/lib/api";
import type {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantSessionSummary,
} from "@peopleos/schemas";

/**
 * Module 10 — PeopleOS Assistant console (client).
 *
 * Owns the whole interactive surface:
 *   - the conversation `turns` (user + assistant, each assistant turn carrying
 *     its summarised tool trace);
 *   - the running `sessionId` — omitted on the first turn (the API mints one and
 *     returns it), then passed back on every subsequent turn to continue;
 *   - the history sidebar (the caller's OWN sessions via `listAssistantSessions`)
 *     with "New chat" + click-to-replay (`getAssistantSession`);
 *   - the latest `suggestedActions` chips (role-aware, server-computed);
 *   - an OPTIMISTIC user bubble + a "working" assistant placeholder while the
 *     agent runs, reconciled when the response lands.
 *
 * The trusted identity context (orgId / userId / role) is derived from the
 * authenticated session SERVER-SIDE and never sent from here; the client only
 * sends the message (+ sessionId). Every wire shape comes from
 * `@peopleos/schemas`; nothing is redeclared.
 */
export function AssistantConsole() {
  const queryClient = useQueryClient();

  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [turns, setTurns] = React.useState<AssistantTurn[]>([]);
  const [suggestedActions, setSuggestedActions] = React.useState<string[]>([]);

  // The caller's own session history (newest-first server-side). Scoped to the
  // authenticated user + org server-side — no userId/orgId is sent from here.
  const sessions = useQuery<AssistantSessionSummary[], Error>({
    queryKey: ["assistant", "sessions"],
    queryFn: () => api.listAssistantSessions(),
  });

  // One assistant turn. We append an optimistic user bubble + a pending assistant
  // placeholder before the request, then replace the placeholder on success.
  const chat = useMutation<AssistantChatResponse, Error, AssistantChatRequest>({
    mutationFn: (payload) => api.assistantChat(payload),
    onSuccess: (res) => {
      // Pin the (possibly newly-minted) session so the next turn continues it.
      setSessionId(res.sessionId);
      setSuggestedActions(res.suggestedActions);
      setTurns((prev) => {
        const next = [...prev];
        // Replace the trailing pending placeholder with the real assistant turn.
        const lastIdx = next.length - 1;
        if (lastIdx >= 0 && next[lastIdx]?.pending) {
          next[lastIdx] = {
            role: "ASSISTANT",
            content: res.reply,
            toolCalls: res.toolCalls,
          };
        } else {
          next.push({
            role: "ASSISTANT",
            content: res.reply,
            toolCalls: res.toolCalls,
          });
        }
        return next;
      });
      // A new session (or a re-titled one) should surface in the sidebar.
      void queryClient.invalidateQueries({
        queryKey: ["assistant", "sessions"],
      });
    },
    onError: () => {
      // Drop the pending placeholder so the user can retry cleanly.
      setTurns((prev) =>
        prev.length > 0 && prev[prev.length - 1]?.pending
          ? prev.slice(0, -1)
          : prev,
      );
    },
  });

  const send = (message: string) => {
    // Optimistic user bubble + a pending assistant placeholder while the agent runs.
    setSuggestedActions([]);
    // Clear any stale replay error so a successful send doesn't leave it lingering.
    openSession.reset();
    setTurns((prev) => [
      ...prev,
      { role: "USER", content: message },
      { role: "ASSISTANT", content: "", pending: true },
    ]);
    chat.mutate({ message, ...(sessionId ? { sessionId } : {}) });
  };

  const startNewChat = () => {
    setSessionId(null);
    setTurns([]);
    setSuggestedActions([]);
    chat.reset();
    // Also clear any prior replay error so a fresh thread starts clean.
    openSession.reset();
  };

  // Replay a past session: load its full transcript and make it the active thread.
  const openSession = useMutation({
    mutationFn: (id: string) => api.getAssistantSession(id),
    onSuccess: (detail) => {
      setSessionId(detail.id);
      setTurns(
        detail.messages.map((m) => ({
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
        })),
      );
      // A replayed session has no fresh suggestions until the next turn.
      setSuggestedActions([]);
      // Clear any stale chat-turn error from the previously-active conversation.
      chat.reset();
    },
  });

  const selectSession = (id: string) => {
    if (id === sessionId || openSession.isPending || chat.isPending) return;
    openSession.mutate(id);
  };

  const errorText = chat.isError
    ? chat.error instanceof ApiClientError
      ? `${chat.error.code}: ${chat.error.message}`
      : chat.error.message
    : openSession.isError
      ? "Could not load that conversation. Please try again."
      : null;

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <SessionList
        sessions={sessions.data ?? []}
        activeSessionId={sessionId}
        onSelect={selectSession}
        onNewChat={startNewChat}
        loading={sessions.isLoading}
        error={sessions.isError}
        onRetry={() => void sessions.refetch()}
        className="h-fit md:sticky md:top-4"
      />

      <AssistantThread
        turns={turns}
        suggestedActions={suggestedActions}
        onSend={send}
        pending={chat.isPending || openSession.isPending}
        error={errorText}
      />
    </div>
  );
}
