"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import * as React from "react";

import type { AssistantTurn } from "@/components/assistant/assistant-thread";
import { api, ApiClientError } from "@/lib/api";
import type {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantSessionSummary,
} from "@peopleos/schemas";

/**
 * App-wide Assistant state.
 *
 * This provider is mounted ONCE in the root layout (see app/providers.tsx), so it
 * stays alive while the user navigates between pages. That means an in-flight
 * assistant turn keeps running server-side AND its result lands in this state even
 * if the user leaves /assistant — when they come back, the answer (or the live
 * "working…" placeholder) is exactly where they left it. The conversation is NOT
 * re-created on every visit to the page.
 */
export interface AssistantContextValue {
  sessions: AssistantSessionSummary[];
  sessionsLoading: boolean;
  sessionsError: boolean;
  refetchSessions: () => void;
  sessionId: string | null;
  turns: AssistantTurn[];
  suggestedActions: string[];
  pending: boolean;
  errorText: string | null;
  send: (message: string) => void;
  startNewChat: () => void;
  selectSession: (id: string) => void;
}

const AssistantCtx = React.createContext<AssistantContextValue | null>(null);

export function useAssistant(): AssistantContextValue {
  const ctx = React.useContext(AssistantCtx);
  if (!ctx) {
    throw new Error("useAssistant must be used within <AssistantProvider>");
  }
  return ctx;
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const pathname = usePathname();

  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [turns, setTurns] = React.useState<AssistantTurn[]>([]);
  const [suggestedActions, setSuggestedActions] = React.useState<string[]>([]);

  // Only fetch the history when it's actually relevant (on the assistant page or
  // once a conversation exists) — the provider is global, so we don't want to hit
  // this endpoint from every unrelated page.
  const historyRelevant = Boolean(pathname?.startsWith("/assistant")) || turns.length > 0;
  const sessions = useQuery<AssistantSessionSummary[], Error>({
    queryKey: ["assistant", "sessions"],
    queryFn: () => api.listAssistantSessions(),
    enabled: historyRelevant,
  });

  // One assistant turn. The mutation lives in this always-mounted provider, so it
  // continues running (and reconciles into state) regardless of which page is shown.
  const chat = useMutation<AssistantChatResponse, Error, AssistantChatRequest>({
    mutationFn: (payload) => api.assistantChat(payload),
    onSuccess: (res) => {
      setSessionId(res.sessionId);
      setSuggestedActions(res.suggestedActions);
      setTurns((prev) => {
        const next = [...prev];
        const lastIdx = next.length - 1;
        if (lastIdx >= 0 && next[lastIdx]?.pending) {
          next[lastIdx] = { role: "ASSISTANT", content: res.reply, toolCalls: res.toolCalls };
        } else {
          next.push({ role: "ASSISTANT", content: res.reply, toolCalls: res.toolCalls });
        }
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["assistant", "sessions"] });
    },
    onError: () => {
      setTurns((prev) =>
        prev.length > 0 && prev[prev.length - 1]?.pending ? prev.slice(0, -1) : prev,
      );
    },
  });

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
      setSuggestedActions([]);
      chat.reset();
    },
  });

  const send = React.useCallback(
    (message: string) => {
      setSuggestedActions([]);
      openSession.reset();
      setTurns((prev) => [
        ...prev,
        { role: "USER", content: message },
        { role: "ASSISTANT", content: "", pending: true },
      ]);
      chat.mutate({ message, ...(sessionId ? { sessionId } : {}) });
    },
    [chat, openSession, sessionId],
  );

  const startNewChat = React.useCallback(() => {
    setSessionId(null);
    setTurns([]);
    setSuggestedActions([]);
    chat.reset();
    openSession.reset();
  }, [chat, openSession]);

  const selectSession = React.useCallback(
    (id: string) => {
      if (id === sessionId || openSession.isPending || chat.isPending) return;
      openSession.mutate(id);
    },
    [sessionId, openSession, chat.isPending],
  );

  const errorText = chat.isError
    ? chat.error instanceof ApiClientError
      ? `${chat.error.code}: ${chat.error.message}`
      : chat.error.message
    : openSession.isError
      ? "Could not load that conversation. Please try again."
      : null;

  const value: AssistantContextValue = {
    sessions: sessions.data ?? [],
    sessionsLoading: sessions.isLoading && historyRelevant,
    sessionsError: sessions.isError,
    refetchSessions: () => void sessions.refetch(),
    sessionId,
    turns,
    suggestedActions,
    pending: chat.isPending || openSession.isPending,
    errorText,
    send,
    startNewChat,
    selectSession,
  };

  return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>;
}
