import * as React from "react";

import { CitationList } from "@/components/hr-chat/citation-list";
import { EscalationBanner } from "@/components/hr-chat/escalation-banner";
import { cn } from "@/lib/utils";
import type { ChatFeedback, Citation } from "@peopleos/schemas";

/**
 * ChatBubble — one turn in the Employee HR Assistant conversation (Module 4).
 *
 * User turns are styled distinctly from assistant turns. An assistant turn
 * additionally renders:
 *   - its source `citations` (policy title + section + effective date, with a
 *     "View full policy" link) — RAG faithfulness: every claim is grounded;
 *   - an `EscalationBanner` (+ HR ticket id) when the answer was escalated to a
 *     human — sensitive topics (termination, harassment, salary dispute) and
 *     low-confidence answers are handed off rather than guessed;
 *   - thumbs up/down feedback, recorded per message id.
 *
 * Presentational: the page owns the data + the feedback mutation; this component
 * is typed off the frozen `Citation` / `ChatFeedback` contracts only.
 */
export function ChatBubble({
  role,
  content,
  citations = [],
  escalated = false,
  ticketId = null,
  /** A persisted message id enables feedback; pending/optimistic turns omit it. */
  messageId,
  feedback,
  onFeedback,
  feedbackPending = false,
}: {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  escalated?: boolean;
  ticketId?: string | null;
  messageId?: string | null;
  feedback?: ChatFeedback | null;
  onFeedback?: (messageId: string, feedback: ChatFeedback) => void;
  feedbackPending?: boolean;
}) {
  const isUser = role === "user";

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border bg-muted/40 text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{content}</p>
      </div>

      {!isUser ? (
        <div className="w-full max-w-[85%] space-y-2">
          {citations.length > 0 ? <CitationList citations={citations} /> : null}

          {escalated ? <EscalationBanner ticketId={ticketId} /> : null}

          {messageId && onFeedback ? (
            <FeedbackControl
              messageId={messageId}
              feedback={feedback ?? null}
              onFeedback={onFeedback}
              pending={feedbackPending}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * FeedbackControl — thumbs up / down on a single assistant answer. The selected
 * vote is highlighted; once a vote is recorded the buttons reflect it. Feeds the
 * answer-quality + unresolved-query analytics (spec Module 4 analytics).
 */
function FeedbackControl({
  messageId,
  feedback,
  onFeedback,
  pending,
}: {
  messageId: string;
  feedback: ChatFeedback | null;
  onFeedback: (messageId: string, feedback: ChatFeedback) => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5" aria-label="Rate this answer">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Helpful?
      </span>
      <FeedbackButton
        label="Yes, this was helpful"
        glyph="👍"
        active={feedback === "positive"}
        disabled={pending}
        onClick={() => onFeedback(messageId, "positive")}
      />
      <FeedbackButton
        label="No, this was not helpful"
        glyph="👎"
        active={feedback === "negative"}
        disabled={pending}
        onClick={() => onFeedback(messageId, "negative")}
      />
    </div>
  );
}

function FeedbackButton({
  label,
  glyph,
  active,
  disabled,
  onClick,
}: {
  label: string;
  glyph: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md border text-xs transition-colors disabled:opacity-50",
        active
          ? "border-primary bg-primary/10"
          : "border-input bg-background hover:bg-accent",
      )}
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
}
