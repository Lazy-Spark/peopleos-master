import { clerkPlugin, getAuth } from "@clerk/fastify";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { env, isProduction } from "../env.js";
import { UserRole } from "@peopleos/schemas";

/**
 * The authenticated principal attached to every request as `request.auth`.
 * `orgId` is the tenant the request operates within; it MUST come from a trusted
 * source (Clerk session in prod), never from a client-controlled value.
 */
export interface AuthContext {
  userId: string;
  orgId: string;
  role: z.infer<typeof UserRole>;
  /** How the tenant was resolved — gates the membership check + dev-only paths. */
  source: "clerk" | "dev";
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const uuid = z.string().uuid();

/**
 * Shape of the custom claims we expect on the Clerk session token. Configure the
 * Clerk JWT template to emit `org_id` (the PeopleOS Organisation id) and `role`.
 */
const ClerkClaims = z.object({
  orgId: uuid.optional(),
  org_id: uuid.optional(),
  role: UserRole.optional(),
});

/**
 * Resolve the tenant + role from a verified Clerk session. We accept either
 * `orgId` or `org_id` from custom claims (templates vary), and fall back to
 * Clerk's native `orgId` if present. The role defaults to EMPLOYEE (least
 * privilege) when the token carries no role claim.
 */
function authFromClerk(request: FastifyRequest): AuthContext | null {
  const clerk = getAuth(request);
  if (!clerk.userId) return null;

  const claims = ClerkClaims.safeParse(clerk.sessionClaims ?? {});
  const claimOrgId = claims.success ? (claims.data.orgId ?? claims.data.org_id) : undefined;
  // Clerk's native organisation id (when Clerk Organizations is used) is a string
  // like "org_…", not a UUID — only accept it if it is a UUID matching our schema.
  const nativeOrgId = uuid.safeParse(clerk.orgId).success ? (clerk.orgId ?? undefined) : undefined;
  const orgId = claimOrgId ?? nativeOrgId;
  if (!orgId) return null;

  const role = claims.success && claims.data.role ? claims.data.role : "EMPLOYEE";
  return { userId: clerk.userId, orgId, role, source: "clerk" };
}

/**
 * DEV-ONLY fallback: trust an `X-Org-Id` header so the API is runnable against the
 * seed without a real Clerk session. This is GATED on NODE_ENV !== 'production' and
 * is the ONLY path that reads the tenant from a client-supplied value. In prod the
 * org id ALWAYS comes from the verified Clerk session.
 */
function authFromHeader(request: FastifyRequest): AuthContext | null {
  if (isProduction) return null;
  const headerOrg = request.headers["x-org-id"];
  const orgId = Array.isArray(headerOrg) ? headerOrg[0] : headerOrg;
  if (!orgId || !uuid.safeParse(orgId).success) return null;

  const headerUser = request.headers["x-user-id"];
  const userId = (Array.isArray(headerUser) ? headerUser[0] : headerUser) ?? "00000000-0000-0000-0000-0000000000a1";

  const headerRole = request.headers["x-user-role"];
  const rawRole = Array.isArray(headerRole) ? headerRole[0] : headerRole;
  const parsedRole = UserRole.safeParse(rawRole);
  const role = parsedRole.success ? parsedRole.data : "ADMIN";

  return { userId, orgId, role, source: "dev" };
}

/**
 * Auth plugin. Registers Clerk (only in prod, or in dev when a secret key is
 * configured) and adds an onRequest hook that populates `request.auth`. It does
 * NOT reject unauthenticated requests itself — that is the tenancy plugin's job —
 * so health and docs routes can opt out of tenancy while still passing through.
 */
const authPlugin: FastifyPluginAsync = async (app) => {
  const clerkConfigured = Boolean(env.CLERK_SECRET_KEY);

  if (clerkConfigured) {
    await app.register(clerkPlugin, {
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
  } else if (isProduction) {
    // env.ts already enforces this, but guard here too — never run prod without Clerk.
    throw new Error("Clerk is not configured but NODE_ENV=production");
  }

  app.addHook("onRequest", async (request) => {
    let ctx: AuthContext | null = null;
    if (clerkConfigured) {
      try {
        ctx = authFromClerk(request);
      } catch {
        // Token absent/invalid — leave unauthenticated; tenancy guard will reject.
        ctx = null;
      }
    }
    // Dev header fallback ONLY when no real Clerk backend is configured at all.
    // If Clerk is configured (any non-local environment), never let an X-Org-Id
    // header assert a tenant — that would be a trivial spoofing path on staging.
    if (!ctx && !clerkConfigured) ctx = authFromHeader(request);
    if (ctx) request.auth = ctx;
  });
};

export default fp(authPlugin, { name: "auth" });
