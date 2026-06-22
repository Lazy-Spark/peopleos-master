import { HrChatConversation } from "./hr-chat-conversation";

/**
 * Module 4 — Employee HR Assistant route. A thin shell; the interactive chat
 * (conversation state, sessionId across turns, the `askHrChat` mutation, and
 * per-answer feedback) lives in the `HrChatConversation` client component.
 *
 * The assistant answers ONLY from the company's published policies and cites
 * every claim; sensitive topics (termination, harassment, salary dispute) and
 * low-confidence answers escalate to a human HR Business Partner.
 */
export default function HrChatPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">HR Assistant</h1>
        <p className="text-sm text-muted-foreground">
          Your company&apos;s policies, answered. Ask about PTO, benefits, parental
          leave, conduct, and more — every answer is grounded in published policy
          and cites its source. Sensitive matters are routed to a human HRBP.
        </p>
      </div>

      <HrChatConversation />
    </div>
  );
}
