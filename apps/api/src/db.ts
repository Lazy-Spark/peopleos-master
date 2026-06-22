import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { env } from "./env.js";

/**
 * Prisma client bound to DATABASE_URL_APP — the peopleos_app role, which is
 * SUBJECT to Row-Level Security (see prisma/rls.sql). We deliberately do NOT use
 * the owner DATABASE_URL here: the owner bypasses RLS and must never serve traffic.
 *
 * The base Prisma client reads `DATABASE_URL` from the datasource block in
 * schema.prisma, so we override the datasource URL explicitly with the app role.
 */
export const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL_APP } },
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/** A Prisma transaction client (what `$transaction(fn)` hands the callback). */
export type TxClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

const uuid = z.string().uuid();

/**
 * Run `fn` inside a transaction that has the tenant context set, so every query
 * it issues is filtered by RLS to the given org.
 *
 * WHY a transaction: the RLS policies read `app.current_org_id` via
 * `current_setting('app.current_org_id', true)`. That GUC must be set on the SAME
 * connection that runs the queries, and it must be transaction-local so it cannot
 * leak to the next request that reuses the pooled connection. `$transaction`
 * pins one connection for the whole callback; `set_config(..., true)` scopes the
 * value to this transaction only. If the var is never set, `current_setting`
 * returns NULL and every policy predicate is false → ZERO rows (fail-closed).
 *
 * WHY set_config (not `SET LOCAL`): SET LOCAL cannot take a bound parameter, which
 * would force string interpolation of the org id into SQL. `set_config('key', $1,
 * true)` accepts the org id as a real bound parameter — injection-safe. We still
 * validate it is a UUID first as defence-in-depth.
 *
 * ALL tenant-scoped queries MUST go through this helper. Never query tenant tables
 * on the bare `prisma` client; without the GUC set you will (correctly) get nothing.
 */
export async function withTenant<T>(
  orgId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  const parsed = uuid.safeParse(orgId);
  if (!parsed.success) {
    throw new Error(`withTenant: orgId must be a valid UUID, got: ${String(orgId)}`);
  }

  return prisma.$transaction(async (tx) => {
    // Parameterised, transaction-local set. `true` = local to this transaction.
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${parsed.data}, true)`;
    return fn(tx);
  });
}
