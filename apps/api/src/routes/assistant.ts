import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantContext,
  AssistantHistoryMessage,
  AssistantMessage,
  AssistantSessionDetail,
  AssistantSessionSummary,
  ToolCallTrace,
  type ToolCallTrace as TToolCallTrace,
} from "@peopleos/schemas";
import type { Prisma, AssistantMessage as PrismaAssistantMessage } from "@prisma/client";
import { withTenant, type TxClient } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import type { AuthContext } from "../plugins/auth.js";
import { writeAudit } from "../lib/audit.js";
import { forbidden, notFound } from "../lib/errors.js";
import { aiClient } from "../lib/aiClient.js";
import { buildOrgContext } from "../lib/orgContext.js";

/**
 * Module 10 — Agentic HR Assistant: the PUBLIC chat surface. Mounted under /api/v1,
 * tenant-scoped via requireTenant + withTenant(orgId).
 *
 *   POST /assistant/chat            send a turn → run the agent → persist + reply
 *   GET  /assistant/sessions        the caller's OWN session summaries
 *   GET  /assistant/sessions/:id    the caller's OWN session detail (404 otherwise)
 *
 * THE SECURITY MODEL (the capstone's whole point):
 *   - A user only ever touches their OWN sessions: every session is USER-SCOPED to the
 *     resolved internal User.id; reads/writes are gated on ownership on top of RLS.
 *   - The TRUSTED AssistantContext { orgId, userId, role } is built HERE from the
 *     authenticated session (NEVER a client body) and relayed to the AI service, which
 *     attaches it to every tool dispatch. context.userId is the INTERNAL User.id (we map
 *     a Clerk principal → User.id first), so the dispatcher can resolve "my employee"
 *     and re-run per-tool governance off the same trusted identity.
 *   - The reply is CoT-free; the persisted toolCalls trace is a SUMMARY only (never raw,
 *     possibly-sensitive tool output). Every chat is audited.
 */

const SessionIdParam = z.object({ id: z.string().uuid() });
const SessionListResponse = z.object({ items: z.array(AssistantSessionSummary) });

/** How many recent messages to replay as agent history (bounded context window). */
const HISTORY_LIMIT = 20;
/** How many of the caller's sessions to list. */
const SESSION_LIST_LIMIT = 50;

/** A Prisma AssistantMessage row → the frozen AssistantMessage wire contract. */
function serializeMessage(row: PrismaAssistantMessage): z.infer<typeof AssistantMessage> {
  return AssistantMessage.parse({
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    // toolCalls is a JSON column of ToolCallTrace[]; parse-guard it so a malformed row
    // can never crash a read (and never leak a non-contract field into a response).
    toolCalls: z.array(ToolCallTrace).catch([]).parse(row.toolCalls),
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Resolve the caller's INTERNAL User.id from the session principal. In prod the
 * principal is a Clerk id → map it to User.id; in dev the principal IS the User.id.
 * This is the userId that becomes AssistantContext.userId, so the internal dispatcher
 * can resolve "my employee" and run governance off the trusted identity. Throws 403 if
 * no user record is linked (a session must belong to a real user).
 */
async function resolveUserId(tx: TxClient, auth: AuthContext): Promise<string> {
  if (auth.source !== "clerk") return auth.userId;
  const u = await tx.user.findFirst({
    where: { clerkUserId: auth.userId },
    select: { id: true },
  });
  if (!u) throw forbidden("No user record is linked to your account.");
  return u.id;
}

const assistantRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Chat: one agent turn ──────────────────────────────────────────────────────
  r.post(
    "/assistant/chat",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["assistant"],
        summary: "Agentic HR Assistant — one chat turn (Module 10 capstone).",
        description:
          "Loads-or-creates the caller's USER-SCOPED AssistantSession, replays recent history, persists the user turn, and runs the AI service's role-aware ReAct agent with the TRUSTED context { orgId, userId, role } (from the session, never the body) + the org prompt context. The agent's tools call back into the secret-authed /internal/assistant/tool dispatcher, which re-enforces tenancy + per-tool role governance from that same context. Persists the assistant turn + a SUMMARISED tool trace and returns a CoT-free reply, the trace, and role-aware suggested actions. Audited. 502 if the AI service is unavailable.",
        body: AssistantChatRequest,
        response: { 200: AssistantChatResponse, 400: ApiError, 401: ApiError, 404: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      const { sessionId: requestedSessionId, message } = request.body;

      // ── Phase 1: resolve the user, load-or-create the OWN session + history ──────
      const { session, history, internalUserId, org } = await withTenant(orgId, async (tx) => {
        const userId = await resolveUserId(tx, auth);

        let sess =
          requestedSessionId != null
            ? await tx.assistantSession.findUnique({ where: { id: requestedSessionId } })
            : null;
        // A sessionId not in this org is invisible under RLS → 404.
        if (requestedSessionId != null && !sess) {
          throw notFound(`Assistant session ${requestedSessionId} not found`);
        }
        // OWNERSHIP: a user only ever touches their OWN sessions (RLS scopes by org only).
        // A same-org peer's session is hidden behind a 404 (don't reveal existence).
        if (sess && sess.userId !== userId) {
          throw notFound(`Assistant session ${requestedSessionId} not found`);
        }
        if (!sess) {
          sess = await tx.assistantSession.create({
            data: {
              orgId,
              userId,
              // A first-line title from the opening message (UI session list label).
              title: message.length > 80 ? `${message.slice(0, 77)}…` : message,
            },
          });
        }

        // Recent history (oldest-first) for the agent's context window.
        const recent = await tx.assistantMessage.findMany({
          where: { sessionId: sess.id },
          // id is a deterministic secondary key so two rows sharing a createdAt timestamp
          // can never replay in a non-deterministic order (e.g. an assistant turn before
          // its own user turn).
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: HISTORY_LIMIT,
        });
        const historyMsgs = recent
          .reverse()
          .map((m) =>
            AssistantHistoryMessage.parse({
              role: m.role === "ASSISTANT" ? "assistant" : "user",
              content: m.content,
            }),
          );

        const orgRow = await tx.organisation.findUnique({ where: { id: orgId } });
        return { session: sess, history: historyMsgs, internalUserId: userId, org: orgRow };
      });

      // ── Phase 2: persist the USER turn (capture its id to compensate on agent failure) ──
      const userMessageId = await withTenant(orgId, async (tx) => {
        const created = await tx.assistantMessage.create({
          data: {
            orgId,
            sessionId: session.id,
            role: "USER",
            content: message,
            toolCalls: [] as unknown as Prisma.InputJsonValue,
          },
        });
        return created.id;
      });

      // ── Phase 3: run the agent — context from the SESSION, never the body ────────
      // AssistantContext.userId is the INTERNAL User.id so the dispatcher can resolve
      // "my employee" + run governance off the trusted identity.
      const agentContext = AssistantContext.parse({ orgId, userId: internalUserId, role });
      let result: Awaited<ReturnType<typeof aiClient.assistantChat>>;
      try {
        result = await aiClient.assistantChat({
          message,
          history,
          context: agentContext,
          orgContext: buildOrgContext(org, role),
        });
      } catch (err) {
        // The agent failed (e.g. the AI service is unavailable → 502). Don't leave an
        // orphan USER turn with no assistant reply in the session; remove it so the
        // session history stays consistent on the next turn. Best-effort cleanup — never
        // let a delete failure mask the original error.
        await withTenant(orgId, async (tx) => {
          await tx.assistantMessage.delete({ where: { id: userMessageId } });
        }).catch(() => {});
        throw err;
      }
      const toolCalls: TToolCallTrace[] = z.array(ToolCallTrace).parse(result.toolCalls);

      // ── Phase 4: persist the ASSISTANT turn + the summarised trace + audit ───────
      await withTenant(orgId, async (tx) => {
        await tx.assistantMessage.create({
          data: {
            orgId,
            sessionId: session.id,
            role: "ASSISTANT",
            content: result.reply,
            // The trace is a SUMMARY only (tool + ok + short summary) — never raw output.
            toolCalls: toolCalls as unknown as Prisma.InputJsonValue,
          },
        });
        // Touch the session so the list orders by most-recent activity.
        await tx.assistantSession.update({
          where: { id: session.id },
          data: { updatedAt: new Date() },
        });
        await writeAudit(tx, {
          actorId: internalUserId,
          action: "assistant.chat",
          entityType: "assistant_session",
          entityId: session.id,
          // Governance metadata only — which tools ran + their ok flags, never message text.
          payload: {
            role,
            toolCalls: toolCalls.map((t) => ({ tool: t.tool, ok: t.ok })),
            toolCount: toolCalls.length,
          },
          ip: request.ip,
        });
      });

      return AssistantChatResponse.parse({
        sessionId: session.id,
        reply: result.reply,
        toolCalls,
        suggestedActions: result.suggestedActions,
      });
    },
  );

  // ── List the caller's OWN sessions ──────────────────────────────────────────────
  r.get(
    "/assistant/sessions",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["assistant"],
        summary: "List your own Agentic Assistant sessions (Module 10).",
        description:
          "Returns the caller's OWN AssistantSessionSummary rows (id, title, updatedAt), newest first. A user only ever sees their own sessions (gated on ownership over RLS).",
        response: { 200: SessionListResponse, 401: ApiError },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId } = auth;
      return withTenant(orgId, async (tx) => {
        const userId = await resolveUserId(tx, auth);
        const rows = await tx.assistantSession.findMany({
          where: { userId },
          orderBy: { updatedAt: "desc" },
          take: SESSION_LIST_LIMIT,
          select: { id: true, title: true, updatedAt: true },
        });
        const items = rows.map((row) =>
          AssistantSessionSummary.parse({
            id: row.id,
            title: row.title,
            updatedAt: row.updatedAt.toISOString(),
          }),
        );
        return { items };
      });
    },
  );

  // ── Get one of the caller's OWN sessions (detail) ───────────────────────────────
  r.get(
    "/assistant/sessions/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["assistant"],
        summary: "Get one of your own assistant sessions with its messages (Module 10).",
        description:
          "Returns the session + its messages (oldest first), including each message's summarised tool trace. OWN only: a session that is not the caller's (or another org's) is a 404 — never reveal existence.",
        params: SessionIdParam,
        response: { 200: AssistantSessionDetail, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId } = auth;
      const { id } = request.params;

      return withTenant(orgId, async (tx) => {
        const userId = await resolveUserId(tx, auth);
        const session = await tx.assistantSession.findUnique({ where: { id } });
        // Foreign-org (RLS-invisible) OR not-owned → 404 (hide existence).
        if (!session || session.userId !== userId) {
          throw notFound(`Assistant session ${id} not found`);
        }
        const messages = await tx.assistantMessage.findMany({
          where: { sessionId: id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return AssistantSessionDetail.parse({
          id: session.id,
          orgId: session.orgId,
          userId: session.userId,
          title: session.title,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
          messages: messages.map(serializeMessage),
        });
      });
    },
  );
};

export default assistantRoutes;
