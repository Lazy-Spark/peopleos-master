import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  AskRequest,
  AskResponse,
  ChatAnswerRequest,
  ChatFeedbackRequest,
  ChatMessageRecord,
  ChatSessionHistory,
  EmbedRequest,
  EmployeeChatContext,
  HrTicket,
  HrTicketCategory,
  HrTicketStatus,
  pageResponse,
  type EmployeeChatContext as TEmployeeChatContext,
} from "@peopleos/schemas";
import { withTenant } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { writeAudit } from "../lib/audit.js";
import { forbidden, notFound } from "../lib/errors.js";
import { aiClient } from "../lib/aiClient.js";
import { buildOrgContext } from "../lib/orgContext.js";
import { retrieveChunks } from "../lib/retrieval.js";
import { appendTurns, getHistory } from "../lib/chatMemory.js";
import { serializeChatMessage, serializeHrTicket } from "../lib/serialize.js";

/**
 * Module 4 — Employee HR Chatbot (RAG over company knowledge). Mounted under
 * /api/v1, tenant-scoped via requireTenant + withTenant(orgId).
 *
 *   POST  /api/v1/hr-chat/ask                       ask the chatbot (the RAG loop)
 *   POST  /api/v1/hr-chat/messages/:id/feedback     thumbs up/down on an answer
 *   GET   /api/v1/hr-chat/sessions/:id              durable session transcript
 *   GET   /api/v1/hr-tickets                         list escalation tickets
 *   PATCH /api/v1/hr-tickets/:id                     update status/assignee — ADMIN/HRBP
 *
 * The ask flow: resolve/create a ChatSession → load the Redis sliding-window memory →
 * embed the query → hybrid-retrieve the top-k ACTIVE policy chunks (org-scoped) →
 * build the caller's non-PII EmployeeChatContext → call the AI service for a GROUNDED
 * answer (it answers ONLY from the chunks, cites every claim, and SAYS SO + escalates
 * when the answer is not in context or the topic is sensitive) → persist both turns →
 * append to Redis → open an HR ticket on escalation. The answer is whatever the AI
 * returned — the API never edits or invents policy text.
 */

/** Roles permitted to triage HR tickets (people-ops). */
const TICKET_WRITE_ROLES = new Set(["ADMIN", "HRBP"]);

/** Roles that may access ANY user's chat session (people-ops support). */
const SESSION_OVERRIDE_ROLES = new Set(["ADMIN", "HRBP"]);

/**
 * A chat session bound to a user is PRIVATE to that user — HR transcripts hold
 * sensitive content (termination, harassment, salary disputes). RLS only scopes by
 * ORG, so we additionally gate session + message access on OWNERSHIP: the caller must
 * own the session, unless they are ADMIN/HRBP (people-ops support). An unbound
 * (userId-null) session has no owner to protect. Callers are hidden a foreign session
 * behind a 404 (don't reveal existence).
 */
function canAccessSession(
  sessionUserId: string | null,
  callerUserId: string | null,
  role: string,
): boolean {
  if (sessionUserId == null) return true;
  if (SESSION_OVERRIDE_ROLES.has(role)) return true;
  return callerUserId != null && sessionUserId === callerUserId;
}

/** Top-k chunks to retrieve and ground the answer in (spec Module 4 step 2: top-5). */
const RETRIEVAL_K = 5;

const MessageIdParam = z.object({ id: z.string().uuid() });
const SessionIdParam = z.object({ id: z.string().uuid() });
const TicketIdParam = z.object({ id: z.string().uuid() });

const HrTicketListResponse = pageResponse(HrTicket);

/** PATCH body for ticket triage: status and/or assignee (at least one). */
const UpdateHrTicketBody = z
  .object({
    status: HrTicketStatus.optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assigneeId !== undefined, {
    message: "Provide at least one of status or assigneeId",
  });

/**
 * Map the escalation signal to an HrTicket category. A detected sensitive topic
 * (termination/harassment/salary dispute) → SENSITIVE; otherwise derive from the AI's
 * classified intent (ACTION_REQUEST → ACTION, ESCALATE/POLICY_QUESTION → POLICY),
 * defaulting to OTHER.
 */
function ticketCategory(
  sensitiveTopic: string | null,
  intent: "POLICY_QUESTION" | "ACTION_REQUEST" | "ESCALATE",
): z.infer<typeof HrTicketCategory> {
  if (sensitiveTopic) return "SENSITIVE";
  if (intent === "ACTION_REQUEST") return "ACTION";
  if (intent === "POLICY_QUESTION" || intent === "ESCALATE") return "POLICY";
  return "OTHER";
}

/** A short, single-line subject derived from the user's query (never PII-mined). */
function ticketSubject(query: string): string {
  const oneLine = query.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine || "HR assistance request";
}

const hrChatRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Ask the chatbot ─────────────────────────────────────────────────────────
  r.post(
    "/hr-chat/ask",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["hr-chat"],
        summary: "Ask the employee HR chatbot a question (Module 4 — grounded RAG).",
        description:
          "Resolves/creates a ChatSession, loads the Redis memory window, embeds the query, hybrid-retrieves the top-k ACTIVE policy chunks (org-scoped), and asks the AI service for an answer grounded ONLY in those chunks (every claim cites policy name + section + effective date; out-of-context questions say so and offer escalation). Persists both turns, appends to Redis, and opens an HR ticket when the answer escalates (sensitive topic / low confidence).",
        body: AskRequest,
        response: { 200: AskResponse, 400: ApiError, 401: ApiError, 404: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { message, sessionId: requestedSessionId, channel } = request.body;

      // ── Phase 1: resolve/create the session + load org + caller context ───────
      // Personalisation uses ONLY the caller's own department/location/hireDate; we
      // never read another person's data. There is no Employee model in the frozen
      // schema, so the non-PII fields are currently null (the contract allows null);
      // when an Employee/profile table lands, populate them from the caller's row.
      const { session, employeeContext, org } = await withTenant(orgId, async (tx) => {
        let sess =
          requestedSessionId != null
            ? await tx.chatSession.findUnique({ where: { id: requestedSessionId } })
            : null;
        // A sessionId that does not belong to this org is invisible under RLS → 404,
        // so a client cannot resume someone else's conversation.
        if (requestedSessionId != null && !sess) {
          throw notFound(`Chat session ${requestedSessionId} not found`);
        }
        // A user's session is private; a same-org peer must not resume it (RLS scopes
        // by org only). Hide existence behind a 404 rather than a 403.
        if (sess && !canAccessSession(sess.userId, userId, role)) {
          throw notFound(`Chat session ${requestedSessionId} not found`);
        }
        if (!sess) {
          sess = await tx.chatSession.create({
            data: { orgId, userId: userId ?? null, channel },
          });
        }

        const orgRow = await tx.organisation.findUnique({ where: { id: orgId } });

        // Caller's own context only. No Employee table → null fields for now.
        const ctx: TEmployeeChatContext = EmployeeChatContext.parse({
          department: null,
          location: null,
          hireDate: null,
        });

        return { session: sess, employeeContext: ctx, org: orgRow };
      });

      // ── Phase 2: live memory window (Redis) ───────────────────────────────────
      const history = await getHistory(session.id);

      // ── Phase 3: embed the query, then hybrid-retrieve top-k policy chunks ────
      const embedRes = await aiClient.embed(EmbedRequest.parse({ texts: [message] }));
      const queryEmbedding = embedRes.embeddings[0] ?? [];

      const candidateChunks = await withTenant(orgId, (tx) =>
        retrieveChunks(tx, orgId, queryEmbedding, message, RETRIEVAL_K),
      );

      // ── Phase 4: grounded answer from the AI service ──────────────────────────
      const answer = await aiClient.chatAnswer(
        ChatAnswerRequest.parse({
          orgId,
          query: message,
          history,
          candidateChunks,
          employeeContext,
          orgContext: buildOrgContext(org, role),
        }),
      );

      // ── Phase 5: persist both turns + (on escalation) open an HR ticket ───────
      const persisted = await withTenant(orgId, async (tx) => {
        await tx.chatMessage.create({
          data: {
            orgId,
            sessionId: session.id,
            role: "user",
            content: message,
            // User turns carry no citations; the column default is [] but we set it
            // explicitly so the row is self-describing.
            citations: [] as unknown as Prisma.InputJsonValue,
            topic: answer.topic,
          },
        });
        const assistantMsg = await tx.chatMessage.create({
          data: {
            orgId,
            sessionId: session.id,
            role: "assistant",
            content: answer.answer,
            // Citations live on the assistant turn (the grounded claims).
            citations: answer.citations as unknown as Prisma.InputJsonValue,
            topic: answer.topic,
          },
        });

        let ticketId: string | null = null;
        if (answer.escalate) {
          const ticket = await tx.hrTicket.create({
            data: {
              orgId,
              raisedById: userId ?? null,
              assigneeId: null,
              category: ticketCategory(answer.sensitiveTopic, answer.intent),
              subject: ticketSubject(message),
              // Pre-populate the employee's query + why it escalated (spec step 5) so
              // the HRBP has full context without opening the chat session.
              description: [
                `Employee query: ${message}`,
                answer.escalationReason
                  ? `Escalation reason: ${answer.escalationReason}`
                  : "Escalated by the HR chatbot for a human Business Partner.",
              ].join("\n\n"),
              status: "OPEN",
              sessionId: session.id,
            },
          });
          ticketId = ticket.id;

          await writeAudit(tx, {
            actorId: userId,
            action: "hr_chat.escalate",
            entityType: "hr_ticket",
            entityId: ticket.id,
            payload: {
              sessionId: session.id,
              category: ticket.category,
              sensitiveTopic: answer.sensitiveTopic,
              intent: answer.intent,
              confidence: answer.confidence,
            },
            ip: request.ip,
          });
        }

        // Bump the session's activity clock (resume-from-any-channel semantics).
        await tx.chatSession.update({
          where: { id: session.id },
          data: { lastActiveAt: new Date() },
        });

        return { assistantMessageId: assistantMsg.id, ticketId };
      });

      // ── Phase 6: refresh the Redis sliding window with this exchange ──────────
      await appendTurns(session.id, [
        { role: "user", content: message },
        { role: "assistant", content: answer.answer },
      ]);

      return AskResponse.parse({
        sessionId: session.id,
        messageId: persisted.assistantMessageId,
        answer: answer.answer,
        citations: answer.citations,
        intent: answer.intent,
        escalated: answer.escalate,
        ticketId: persisted.ticketId,
        confidence: answer.confidence,
      });
    },
  );

  // ── Feedback on an assistant message ──────────────────────────────────────────
  r.post(
    "/hr-chat/messages/:id/feedback",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["hr-chat"],
        summary: "Record thumbs up/down feedback on a chatbot answer.",
        description:
          "Sets ChatMessage.feedback (positive | negative) for analytics on unresolved queries / knowledge-base gaps. Tenant-scoped (a message from another org is invisible → 404).",
        params: MessageIdParam,
        body: ChatFeedbackRequest,
        response: { 200: ChatMessageRecord, 400: ApiError, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id } = request.params;
      const { feedback } = request.body;

      return withTenant(orgId, async (tx) => {
        // Gate on session ownership: a peer must not rate another employee's answer.
        const existing = await tx.chatMessage.findUnique({
          where: { id },
          select: { id: true, session: { select: { userId: true } } },
        });
        if (!existing || !canAccessSession(existing.session?.userId ?? null, userId, role)) {
          throw notFound(`Chat message ${id} not found`);
        }
        const updated = await tx.chatMessage.update({ where: { id }, data: { feedback } });
        return serializeChatMessage(updated);
      });
    },
  );

  // ── Session transcript (durable record) ───────────────────────────────────────
  r.get(
    "/hr-chat/sessions/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["hr-chat"],
        summary: "Get a chat session's durable transcript.",
        description:
          "Returns the session's messages (oldest first) from Postgres — the durable record (the Redis window is only the live LLM context). Tenant-scoped: a session from another org is invisible → 404.",
        params: SessionIdParam,
        response: { 200: ChatSessionHistory, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id } = request.params;

      return withTenant(orgId, async (tx) => {
        // A user's transcript is private to them (sensitive content); only the owner
        // or ADMIN/HRBP may read it. Foreign session → 404 (don't reveal existence).
        const session = await tx.chatSession.findUnique({
          where: { id },
          select: { id: true, userId: true },
        });
        if (!session || !canAccessSession(session.userId, userId, role)) {
          throw notFound(`Chat session ${id} not found`);
        }
        const messages = await tx.chatMessage.findMany({
          where: { sessionId: id },
          orderBy: { createdAt: "asc" },
        });
        return ChatSessionHistory.parse({
          sessionId: id,
          messages: messages.map(serializeChatMessage),
        });
      });
    },
  );

  // ── List HR escalation tickets ────────────────────────────────────────────────
  r.get(
    "/hr-tickets",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["hr-chat"],
        summary: "List HR escalation tickets for the org.",
        description:
          "Returns the org's HR tickets (newest first), optionally filtered by status. Created by the chatbot on escalation; triaged by ADMIN/HRBP.",
        querystring: z.object({ status: HrTicketStatus.optional() }),
        response: { 200: HrTicketListResponse, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { status } = request.query;

      return withTenant(orgId, async (tx) => {
        const rows = await tx.hrTicket.findMany({
          where: status ? { status } : {},
          orderBy: { createdAt: "desc" },
        });
        return { items: rows.map(serializeHrTicket), nextCursor: null };
      });
    },
  );

  // ── Triage an HR ticket ─────────────────────────────────────────────────────
  r.patch(
    "/hr-tickets/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["hr-chat"],
        summary: "Update an HR ticket's status/assignee (triage). ADMIN/HRBP.",
        description:
          "Sets the ticket status and/or assignee. Moving to RESOLVED stamps resolvedAt. Restricted to ADMIN/HRBP. Tenant-scoped (a ticket from another org → 404).",
        params: TicketIdParam,
        body: UpdateHrTicketBody,
        response: { 200: HrTicket, 400: ApiError, 401: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id } = request.params;
      const body = request.body;

      if (!TICKET_WRITE_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may triage HR tickets.");
      }

      return withTenant(orgId, async (tx) => {
        const existing = await tx.hrTicket.findUnique({
          where: { id },
          select: { id: true, resolvedAt: true },
        });
        if (!existing) throw notFound(`HR ticket ${id} not found`);

        // assigneeId / raisedById are plain scalar columns on HrTicket (no Prisma
        // relation declared), so we set assigneeId directly rather than via connect.
        const data: Prisma.HrTicketUpdateInput = {};
        if (body.assigneeId !== undefined) {
          data.assigneeId = body.assigneeId;
        }
        if (body.status !== undefined) {
          data.status = body.status;
          // Stamp resolvedAt when first moving to RESOLVED; clear it when re-opening.
          if (body.status === "RESOLVED") {
            data.resolvedAt = existing.resolvedAt ?? new Date();
          } else {
            data.resolvedAt = null;
          }
        }

        const updated = await tx.hrTicket.update({ where: { id }, data });

        await writeAudit(tx, {
          actorId: userId,
          action: "hr_ticket.triage",
          entityType: "hr_ticket",
          entityId: id,
          payload: { status: updated.status, assigneeId: updated.assigneeId },
          ip: request.ip,
        });

        return serializeHrTicket(updated);
      });
    },
  );
};

export default hrChatRoutes;
