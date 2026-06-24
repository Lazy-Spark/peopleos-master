"use client";

import * as React from "react";

import { AssistantThread } from "@/components/assistant/assistant-thread";
import { useAssistant } from "@/components/assistant/assistant-provider";
import { SessionList } from "@/components/assistant/session-list";

/**
 * Module 10 — PeopleOS Assistant console (client).
 *
 * Pure view: all conversation state + the in-flight chat mutation live in the
 * app-wide {@link useAssistant} provider (mounted in the root layout), so a running
 * turn keeps going and its result is preserved when the user navigates to another
 * page and back. This component only renders the current state and forwards intents.
 *
 * The trusted identity context (orgId / userId / role) is derived from the
 * authenticated session SERVER-SIDE and never sent from here; the client only sends
 * the message (+ sessionId). Every wire shape comes from `@peopleos/schemas`.
 */
export function AssistantConsole() {
  const {
    sessions,
    sessionsLoading,
    sessionsError,
    refetchSessions,
    sessionId,
    turns,
    suggestedActions,
    pending,
    errorText,
    send,
    startNewChat,
    selectSession,
  } = useAssistant();

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <SessionList
        sessions={sessions}
        activeSessionId={sessionId}
        onSelect={selectSession}
        onNewChat={startNewChat}
        loading={sessionsLoading}
        error={sessionsError}
        onRetry={refetchSessions}
        className="h-fit md:sticky md:top-4"
      />

      <AssistantThread
        turns={turns}
        suggestedActions={suggestedActions}
        onSend={send}
        pending={pending}
        error={errorText}
      />
    </div>
  );
}
