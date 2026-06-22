import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { env, isProduction } from "../env.js";
import { withTenant, type TxClient } from "../db.js";
import { processTimersAndSla, startInstance } from "../lib/workflowEngine.js";
import { parseWorkflowSteps } from "../lib/serialize.js";

/**
 * Module 9 — Workflow worker tick (the dev engine's periodic sweep).
 *
 * Mirrors jobs/retentionPurge.ts: a CROSS-ORG maintenance sweep the worker runs on an
 * interval. Two responsibilities per tick:
 *   1. processTimersAndSla — fire due TIMER tasks (advance their instances) and mark
 *      PENDING human tasks past dueAt OVERDUE / ESCALATED.
 *   2. SCHEDULED definitions — start a new instance for any ACTIVE, SCHEDULED definition
 *      that is due (the dev scheduler: each definition fires at most once per `everyHours`
 *      window, derived from its `schedule` config; in prod a Temporal Cron Workflow owns
 *      the cadence — see the note at the foot of this file).
 *
 * DISCOVERY vs PROCESSING — the RLS split:
 *   - DISCOVERY is cross-org, so we use the OWNER client (DATABASE_URL, BYPASSES RLS),
 *     exactly like retentionPurge — no single tenant context can see every org's due
 *     work. We use it ONLY to read which orgs have pending work (ids), never to mutate.
 *   - PROCESSING runs PER-ORG inside withTenant(orgId, …) on the RLS-SUBJECT app client,
 *     so every engine read/write is tenant-scoped and the audit-log GUC is set. This keeps
 *     the engine code identical to the request path (it never sees the owner client).
 *
 * When the owner DATABASE_URL is unset the sweep logs and no-ops (like retentionPurge).
 */

const log = pino({
  level: env.LOG_LEVEL,
  ...(isProduction ? {} : { transport: { target: "pino-pretty" } }),
});

/** Bound the number of orgs processed per tick so a large fleet cannot stall the worker. */
const ORG_BATCH = 200;

let ownerClient: PrismaClient | null = null;
function ownerDb(): PrismaClient | null {
  if (!env.DATABASE_URL) return null;
  ownerClient ??= new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  return ownerClient;
}

export interface WorkflowTickResult {
  orgsProcessed: number;
  timersFired: number;
  overdue: number;
  escalated: number;
  scheduledStarted: number;
}

/**
 * Run one sweep. Idempotent and safe to run on any interval: every state change is
 * persisted, completed tasks are no-ops on re-run, and a SCHEDULED definition is only
 * re-fired once its `everyHours` window has elapsed since its last instance.
 */
export async function workflowTick(now: Date = new Date()): Promise<WorkflowTickResult> {
  const empty: WorkflowTickResult = {
    orgsProcessed: 0,
    timersFired: 0,
    overdue: 0,
    escalated: 0,
    scheduledStarted: 0,
  };

  const db = ownerDb();
  if (!db) {
    log.warn("workflow tick skipped: owner DATABASE_URL is not configured");
    return empty;
  }

  // ── DISCOVERY (cross-org, owner client, READ-ONLY) ───────────────────────────
  // Orgs with due timers OR breached human-task SLAs.
  const dueTaskOrgs = await db.workflowTask.findMany({
    where: {
      dueAt: { lte: now },
      OR: [
        { type: "TIMER", status: "PENDING" },
        { type: { in: ["TASK", "APPROVAL"] }, status: "PENDING" },
      ],
    },
    select: { orgId: true },
    distinct: ["orgId"],
    take: ORG_BATCH,
  });
  // Orgs with ACTIVE SCHEDULED definitions (we re-check the per-definition window below).
  const scheduledOrgs = await db.workflowDefinition.findMany({
    where: { trigger: "SCHEDULED", active: true },
    select: { orgId: true },
    distinct: ["orgId"],
    take: ORG_BATCH,
  });

  const orgIds = new Set<string>();
  for (const r of dueTaskOrgs) orgIds.add(r.orgId);
  for (const r of scheduledOrgs) orgIds.add(r.orgId);

  const result: WorkflowTickResult = { ...empty };

  // ── PROCESSING (per-org, RLS-subject app client) ─────────────────────────────
  for (const orgId of orgIds) {
    try {
      await withTenant(orgId, async (tx) => {
        const timers = await processTimersAndSla(tx, now);
        result.timersFired += timers.timersFired;
        result.overdue += timers.overdue;
        result.escalated += timers.escalated;

        result.scheduledStarted += await startDueScheduled(tx, now);
      });
      result.orgsProcessed += 1;
    } catch (err) {
      log.error(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        "workflow tick failed for org",
      );
    }
  }

  if (result.orgsProcessed > 0) {
    log.info(result, "workflow tick completed");
  }
  return result;
}

/**
 * Start an instance for every ACTIVE, SCHEDULED definition in THIS tenant that is due.
 * The dev scheduler is deliberately simple: a definition's `schedule` is read as JSON
 * `{ everyHours: <n> }` (or a bare number of hours). It is due when no instance of it
 * has started within the last `everyHours`. This is window-based (not wall-clock cron)
 * so the dev engine needs no cron parser, yet never double-fires within a window — the
 * key idempotency property for a periodic sweep. The prod adapter uses Temporal Cron.
 */
async function startDueScheduled(tx: TxClient, now: Date): Promise<number> {
  const definitions = await tx.workflowDefinition.findMany({
    where: { trigger: "SCHEDULED", active: true },
  });

  let started = 0;
  for (const definition of definitions) {
    const everyHours = readEveryHours(definition.schedule);
    if (everyHours == null || everyHours <= 0) continue; // no/invalid cadence → skip
    // A degenerate definition with no steps would just complete instantly — skip it so
    // the sweep never churns empty instances every tick.
    if (parseWorkflowSteps(definition.steps).length === 0) continue;

    const windowStart = new Date(now.getTime() - everyHours * 60 * 60 * 1000);
    const recent = await tx.workflowInstance.findFirst({
      where: { definitionId: definition.id, startedAt: { gte: windowStart } },
      select: { id: true },
    });
    if (recent) continue; // already fired within this window → not due

    await startInstance(tx, definition, {
      subjectType: "schedule",
      subjectId: null,
      context: { trigger: "SCHEDULED", scheduledAt: now.toISOString() },
      createdById: null,
    });
    started += 1;
  }
  return started;
}

/**
 * Parse a definition's `schedule` column into an hours-per-window cadence. Accepts
 * either a JSON object `{ "everyHours": 24 }` or a bare numeric string `"24"`. Returns
 * null when the schedule is absent or unparseable (the definition is then never fired
 * by the dev tick — it is still startable manually / by event).
 */
function readEveryHours(schedule: string | null): number | null {
  if (!schedule) return null;
  const trimmed = schedule.trim();
  // Bare number of hours.
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  // JSON `{ everyHours }`.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && "everyHours" in parsed) {
      const v = (parsed as { everyHours: unknown }).everyHours;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
  } catch {
    // Not JSON (e.g. a real cron string "0 9 * * *"). The dev tick does not parse cron;
    // prod (Temporal Cron) does. Treat as "not dev-schedulable".
    return null;
  }
  return null;
}

/** Release the owner Prisma pool (called on worker shutdown). */
export async function closeWorkflowTick(): Promise<void> {
  if (ownerClient) {
    await ownerClient.$disconnect();
    ownerClient = null;
  }
}

/*
 * ── PROD CADENCE (Temporal.io) — documented adapter ───────────────────────────────
 *
 * In prod the worker tick is REPLACED by Temporal's own durable timers, so this sweep
 * is a dev-engine convenience, not load-bearing:
 *   - SCHEDULED definitions → a Temporal Cron Workflow (the `schedule` IS a cron string
 *     there; `readEveryHours` is the dev-only window approximation).
 *   - TIMER steps → `workflow.sleep()` inside the instance Workflow (no external sweep).
 *   - SLA / escalation → a timer that races the human-completion Signal; on timeout the
 *     Workflow runs the escalation Activity directly.
 * The WorkflowInstance/Task rows remain the queryable projection either way, so the
 * "my tasks" inbox + the monitor read identically against dev and prod.
 */
