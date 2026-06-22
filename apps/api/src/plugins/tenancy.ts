import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withTenant } from "../db.js";
import type { AuthContext } from "./auth.js";

const uuid = z.string().uuid();

/**
 * preHandler that asserts an authenticated tenant context exists and that the
 * org id is a UUID. Mount this on every tenant-scoped route group (everything
 * under /api/v1 except health/docs). It is the single gate that turns a missing
 * or malformed tenant into a clean 401/400 with the ApiError envelope, rather
 * than a downstream RLS "zero rows" surprise.
 *
 * Routes use it via `{ preHandler: requireTenant }`.
 */
export async function requireTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.auth;
  if (!auth || !auth.userId) {
    await reply.code(401).send({
      error: { code: "UNAUTHENTICATED", message: "Authentication required." },
    });
    return;
  }
  if (!auth.orgId || !uuid.safeParse(auth.orgId).success) {
    await reply.code(400).send({
      error: {
        code: "ORG_CONTEXT_MISSING",
        message: "A valid organisation context (orgId) is required for this request.",
      },
    });
    return;
  }

  // Defence-in-depth: bind the asserted org claim to a real membership fact. A Clerk
  // JWT carries the org id; we verify the authenticated user actually belongs to that
  // org in our own users table, so a misconfigured or replayed token cannot operate
  // inside an arbitrary tenant (RLS would otherwise trust whatever org the claim set).
  // The dev header path is exempt — seed users have no clerkUserId mapping.
  if (auth.source === "clerk") {
    const member = await withTenant(auth.orgId, (tx) =>
      tx.user.findFirst({ where: { clerkUserId: auth.userId }, select: { id: true } }),
    );
    if (!member) {
      await reply.code(403).send({
        error: {
          code: "NOT_ORG_MEMBER",
          message: "Authenticated user is not a member of this organisation.",
        },
      });
      return;
    }
  }
}

/**
 * Narrow `request.auth` to a guaranteed-present context after `requireTenant`
 * has run. Keeps route handlers free of redundant null checks while staying
 * type-safe (no `any`, no non-null assertions sprinkled through handlers).
 */
export function tenant(request: FastifyRequest): AuthContext {
  const auth = request.auth;
  if (!auth) {
    // Programmer error: requireTenant was not mounted on this route.
    throw new Error("tenant() called without requireTenant preHandler");
  }
  return auth;
}
