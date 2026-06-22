import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";

/**
 * Shared internal-service authentication for the secret-authed `/internal/*` tool
 * routers (Module 2c Recruiter Copilot AND Module 10 Agentic Assistant). Both routers
 * are mounted at the ROOT — OUTSIDE /api/v1 — with NO Clerk/tenancy preHandler, so the
 * ONLY thing that authenticates the calling SERVICE is a constant-time check of the
 * `x-internal-secret` header against `env.AI_SERVICE_SECRET`.
 *
 * TRUST BOUNDARY (read before reusing this elsewhere):
 *   - The secret authenticates the SERVICE (the Python AI service ↔ this API). It does
 *     NOT carry any tenancy: the per-request `orgId` (and, for Module 10, the full
 *     `AssistantContext`) selects the tenant the service is authorised for, and every
 *     query still runs inside withTenant(orgId) so RLS scopes it exactly as a
 *     first-party request would.
 *   - FAIL-CLOSED: when AI_SERVICE_SECRET is unset we refuse ALL internal calls. In
 *     production env.ts makes the secret mandatory at boot, so this only no-ops in dev.
 *   - Bind these routes on the internal network / service mesh only; never expose
 *     /internal/* on the public ingress.
 */

/**
 * Constant-time comparison of the presented secret against the configured one.
 * Returns false (fail-closed) when AI_SERVICE_SECRET is unset or the header is
 * absent/mismatched. `timingSafeEqual` throws on a length mismatch, so we guard
 * lengths first; the configured secret's length is not itself sensitive, so this
 * pre-check is not a meaningful timing oracle.
 */
export function secretMatches(presented: string | undefined): boolean {
  const expected = env.AI_SERVICE_SECRET;
  if (!expected) return false; // fail-closed: no secret configured → refuse all.
  if (typeof presented !== "string" || presented.length === 0) return false;

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * preHandler enforcing the shared-secret guard. 401 (with the uniform ApiError
 * envelope) on any failure. This is the entire authN for an internal router.
 */
export async function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers["x-internal-secret"];
  const presented = Array.isArray(header) ? header[0] : header;
  if (!secretMatches(presented)) {
    await reply.code(401).send({
      error: {
        code: "UNAUTHENTICATED",
        message: "Valid internal service credentials are required.",
      },
    });
  }
}
