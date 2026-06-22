import { AssistantConsole } from "./assistant-console";

export const dynamic = "force-dynamic";

/**
 * Module 10 — PeopleOS Assistant route (the capstone). A thin Server Component
 * shell; the interactive console (the chat thread, the session history sidebar,
 * the conversation + sessionId state, the `assistantChat` mutation, and session
 * replay) lives in the `AssistantConsole` client component.
 *
 * The assistant is an org-wide, ROLE-AWARE agent that orchestrates every prior
 * module's capability as a tool. The whole security model is server-side: the API
 * derives the trusted identity context (orgId / userId / role) from the
 * authenticated session and relays it to the AI ReAct loop, which attaches it to
 * every tool dispatch — the agent can never act outside the caller's role, read
 * another tenant's data, or become a confused deputy. Writes are confirmed first.
 */
export default function AssistantPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          PeopleOS Assistant
        </h1>
        <p className="text-sm text-muted-foreground">
          One place to ask anything across PeopleOS — recruiting, skills,
          attrition, internal mobility, analytics, and workflows. The assistant
          orchestrates each module as a tool, acting only within your role&apos;s
          permissions. Every action is governed and tenant-scoped server-side, and
          it confirms before any write (raising a ticket, starting a workflow,
          sending outreach).
        </p>
      </div>

      <AssistantConsole />
    </div>
  );
}
