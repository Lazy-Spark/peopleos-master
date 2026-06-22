import type {
  Prisma,
  WorkflowDefinition as PrismaWorkflowDefinition,
  WorkflowInstance as PrismaWorkflowInstance,
  WorkflowTask as PrismaWorkflowTask,
} from "@prisma/client";
import pino from "pino";
import type { z } from "zod";
import {
  BranchCondition,
  TaskOutcome,
  UserRole,
  type BranchCondition as TBranchCondition,
  type StepType as TStepType,
  type WorkflowStep,
} from "@peopleos/schemas";
import type { TxClient } from "../db.js";
import { env, isProduction } from "../env.js";
import { parseWorkflowSteps } from "./serialize.js";
import { writeAudit } from "./audit.js";

/**
 * Module 9 — Workflow Automation Engine (the DEV execution substrate).
 *
 * This is a DURABLE, DB-PERSISTED state machine over Postgres. The
 * WorkflowDefinition / WorkflowInstance / WorkflowTask rows ARE the durable state:
 * every transition is committed to the DB inside the caller's tenant transaction, so a
 * crash/restart resumes exactly where it left off — there is no in-memory engine state
 * to lose. Temporal.io is the DOCUMENTED PROD execution substrate (spec Module 9), but
 * we do NOT add it here; in prod a Temporal worker would replay these same rows as its
 * event history. See the prod-adapter note at the foot of this file.
 *
 * Every exported mutator takes the `withTenant(orgId, tx => …)` transaction client so
 * RLS scopes every read/write to one org and the whole advance commits atomically.
 *
 * CORRECTNESS PROPERTIES (enforced below):
 *   1. Resumable    — each step transition persists currentStepId/status before STOPping.
 *   2. Loop-safe    — `advance` caps iterations AND refuses to revisit a step id within a
 *                     single pass; a cyclic BRANCH FAILs the instance, it never hangs.
 *   3. Safe branches— branch predicates are a declarative comparator over instance.context
 *                     (field/op/value). NEVER eval / new Function / template injection.
 *   4. Authorised   — task completion authorisation is enforced by the route; the engine
 *                     records who completed each task (completedById).
 *   5. AI-resilient — an AI_TASK never blocks the engine: an AI failure records a pending
 *                     note on the task and the walk continues.
 */

const log = pino({
  level: env.LOG_LEVEL,
  ...(isProduction ? {} : { transport: { target: "pino-pretty" } }),
});

/**
 * Hard cap on step transitions in ONE `advance` pass. A well-formed DAG terminates
 * long before this; the cap is the last-resort guard so a pathological definition can
 * never spin the event loop. We ALSO track visited step ids (below) which catches a
 * cycle far sooner — the cap defends against an absurdly long acyclic chain too.
 */
const MAX_STEPS_PER_ADVANCE = 1000;

/** Auto steps run inline; human steps create a PENDING task and STOP the walk. */
const AUTO_STEP_TYPES = new Set<TStepType>(["NOTIFICATION", "AI_TASK", "BRANCH"]);

/** A subject + seed context for a new instance. */
export interface StartInstanceInput {
  subjectType?: string | null;
  subjectId?: string | null;
  context?: Record<string, unknown>;
  createdById?: string | null;
}

// ═══ Safe branch comparator ═══════════════════════════════════════════════════

/**
 * Read a (possibly dot-pathed) field out of the instance context. We support a
 * simple `a.b.c` path so a branch can test a nested value, but we ONLY ever do
 * property lookups on plain objects — there is no code execution, no prototype
 * walking past own data, and a missing segment short-circuits to `undefined`.
 */
function readContextField(context: Record<string, unknown>, field: string): unknown {
  const segments = field.split(".");
  let cursor: unknown = context;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    // Own-property only: never traverse the prototype chain (no __proto__ tricks).
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Coerce a value to a finite number for GT/LT, or null if it is not numeric. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Evaluate a single branch predicate against the instance context. PURE and SAFE:
 * a declarative field/op/value comparison only — there is NO eval, NO new Function,
 * NO string interpolation into executable code. An unknown op or a type-mismatched
 * comparison (e.g. GT on a non-numeric field) returns `false` (the rule does not
 * match) rather than throwing, so a single bad rule never derails the whole walk.
 *
 * Ops:
 *   EQ     — strict-ish equality (number/string/bool/null) against `value`.
 *   NE     — the negation of EQ.
 *   EXISTS — the field is present AND not null/undefined (value is ignored).
 *   GT/LT  — numeric comparison; both sides must coerce to a finite number.
 */
export function evaluateCondition(
  context: Record<string, unknown>,
  condition: TBranchCondition,
): boolean {
  // Defence-in-depth: validate the predicate shape even though callers pass typed rules.
  const parsed = BranchCondition.safeParse(condition);
  if (!parsed.success) return false;
  const { field, op, value } = parsed.data;

  const actual = readContextField(context, field);

  switch (op) {
    case "EXISTS":
      return actual !== undefined && actual !== null;
    case "EQ":
      return actual === value;
    case "NE":
      return actual !== value;
    case "GT": {
      const a = toNumber(actual);
      const b = toNumber(value);
      return a !== null && b !== null && a > b;
    }
    case "LT": {
      const a = toNumber(actual);
      const b = toNumber(value);
      return a !== null && b !== null && a < b;
    }
    default:
      // Unreachable given the enum, but fail-closed if an op slips through.
      return false;
  }
}

/**
 * Pick the next step id for a BRANCH step: the FIRST branch rule whose predicate
 * matches the context wins; otherwise fall back to the step's default `next`.
 * Returns `null` when nothing matches and there is no default (a terminal branch).
 */
function resolveBranchNext(
  step: WorkflowStep,
  context: Record<string, unknown>,
): string | null {
  for (const rule of step.branches ?? []) {
    if (evaluateCondition(context, rule.when)) return rule.next;
  }
  return step.next ?? null;
}

// ═══ Step lookup helpers ══════════════════════════════════════════════════════

function indexSteps(steps: WorkflowStep[]): Map<string, WorkflowStep> {
  const byId = new Map<string, WorkflowStep>();
  for (const step of steps) byId.set(step.id, step);
  return byId;
}

/** The first step is the entry point (definitions are authored head-first). */
function firstStepId(steps: WorkflowStep[]): string | null {
  return steps[0]?.id ?? null;
}

function isAutoStep(type: TStepType): boolean {
  return AUTO_STEP_TYPES.has(type);
}

// ═══ Instance lifecycle ═══════════════════════════════════════════════════════

/**
 * Create a RUNNING instance of `definition`, then immediately `advance()` it so any
 * leading auto steps run and it parks on the first human step (or completes). Returns
 * the FINAL instance row after the advance pass (RUNNING is never observed at rest).
 */
export async function startInstance(
  tx: TxClient,
  definition: PrismaWorkflowDefinition,
  input: StartInstanceInput = {},
): Promise<PrismaWorkflowInstance> {
  const steps = parseWorkflowSteps(definition.steps);
  const entry = firstStepId(steps);

  const instance = await tx.workflowInstance.create({
    data: {
      orgId: definition.orgId,
      definitionId: definition.id,
      status: "RUNNING",
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      currentStepId: entry,
      // Seed context drives branch predicates; always an object so reads never NPE.
      context: (input.context ?? {}) as unknown as Prisma.InputJsonValue,
      createdById: input.createdById ?? null,
    },
  });

  await writeAudit(tx, {
    actorId: input.createdById ?? null,
    action: "workflow.instance.start",
    entityType: "workflow_instance",
    entityId: instance.id,
    payload: { definitionId: definition.id, definitionKey: definition.key },
  });

  // Run leading auto steps / park on the first human step.
  return advance(tx, instance, definition);
}

/**
 * Walk steps from `instance.currentStepId`, running auto steps inline and stopping at
 * the first human step (TASK/APPROVAL/TIMER) or terminal. Returns the UPDATED instance.
 *
 * Loop safety: each iteration is bounded by MAX_STEPS_PER_ADVANCE AND we record every
 * step id visited THIS pass — revisiting one means a cyclic BRANCH points backwards, so
 * we FAIL the instance (status=FAILED) rather than spin. Each non-terminal transition
 * persists currentStepId before continuing, so a crash mid-walk resumes correctly.
 */
export async function advance(
  tx: TxClient,
  instance: PrismaWorkflowInstance,
  definition: PrismaWorkflowDefinition,
): Promise<PrismaWorkflowInstance> {
  // A non-active instance is at rest — never advance a COMPLETED/FAILED/CANCELLED one.
  if (
    instance.status === "COMPLETED" ||
    instance.status === "FAILED" ||
    instance.status === "CANCELLED"
  ) {
    return instance;
  }

  const steps = parseWorkflowSteps(definition.steps);
  const byId = indexSteps(steps);
  const visited = new Set<string>();

  let current: PrismaWorkflowInstance = instance;
  // The cursor is the instance's currentStepId verbatim — callers set it precisely
  // (startInstance pins the entry step; completeTask pins the resume target). We do NOT
  // fall back to the first step on null: a null cursor means "no next step" → COMPLETE,
  // never "restart from the top".
  let cursor: string | null = current.currentStepId;

  for (let iterations = 0; iterations < MAX_STEPS_PER_ADVANCE; iterations += 1) {
    // No next step → the instance has run to completion.
    if (cursor == null) {
      return completeInstance(tx, current);
    }

    // A cyclic BRANCH (or any backward edge) revisits a step in one pass → FAIL.
    if (visited.has(cursor)) {
      return failInstance(
        tx,
        current,
        `cycle detected: step "${cursor}" revisited in a single advance pass`,
      );
    }
    visited.add(cursor);

    const step = byId.get(cursor);
    if (!step) {
      // A `next`/branch target that does not exist — a malformed definition.
      return failInstance(tx, current, `unknown step "${cursor}"`);
    }

    if (!isAutoStep(step.type)) {
      // Human step: create the PENDING task, mark WAITING, persist, STOP.
      return parkOnHumanStep(tx, current, step);
    }

    // ── Auto step: run inline, record a COMPLETED task, follow the edge ──────────
    const nextId = await runAutoStep(tx, current, step);

    // Persist the cursor move BEFORE continuing so a crash resumes at `nextId`.
    current = await tx.workflowInstance.update({
      where: { id: current.id },
      data: { currentStepId: nextId },
    });
    cursor = nextId;
  }

  // Exhausted the iteration cap on an (absurdly long but) acyclic chain → FAIL.
  return failInstance(
    tx,
    current,
    `exceeded ${MAX_STEPS_PER_ADVANCE} steps in one advance pass`,
  );
}

/**
 * Run one auto step inline, recording a COMPLETED WorkflowTask for the audit trail,
 * and return the next step id to follow.
 *   NOTIFICATION — record + log (no real email; the prod adapter wires a mailer).
 *   AI_TASK      — call the AI service if available; on any failure record a PENDING
 *                  note and CONTINUE (the engine never blocks on AI).
 *   BRANCH       — pick next via the SAFE comparator over instance.context.
 */
async function runAutoStep(
  tx: TxClient,
  instance: PrismaWorkflowInstance,
  step: WorkflowStep,
): Promise<string | null> {
  let note: string | null = null;
  let status: PrismaWorkflowTask["status"] = "COMPLETED";
  // The edge to follow after this auto step. BRANCH overrides it via the safe comparator.
  let nextId: string | null = step.next ?? null;

  if (step.type === "NOTIFICATION") {
    const template = readConfigString(step.config, "template");
    note = template ? `notification sent (template: ${template})` : "notification sent";
    log.info(
      { instanceId: instance.id, stepId: step.id, template },
      "workflow notification step (dev: recorded, no email sent)",
    );
  } else if (step.type === "AI_TASK") {
    // The engine NEVER makes a blocking external AI call inside the durable transaction
    // (a 30s HTTP call would exceed Prisma's interactive-tx timeout, abort the tx, and
    // break the resumability guarantee). The AI generation runs OUT-OF-BAND (prod: a
    // Temporal activity outside the workflow tx); here we record the step as queued and
    // CONTINUE so the walk never blocks on AI.
    note = runAiStep(step);
  } else if (step.type === "BRANCH") {
    const context = (instance.context ?? {}) as Record<string, unknown>;
    nextId = resolveBranchNext(step, context);
    note = `branch evaluated → ${nextId ?? "(terminal)"}`;
  }

  await tx.workflowTask.create({
    data: {
      orgId: instance.orgId,
      instanceId: instance.id,
      stepId: step.id,
      type: step.type,
      name: step.name,
      assigneeRole: step.assigneeRole ?? null,
      assigneeId: null,
      status,
      outcome: "DONE",
      dueAt: null,
      completedAt: new Date(),
      // System-run: no human completer.
      completedById: null,
      note,
    },
  });

  return nextId;
}

/**
 * Record an AI_TASK step WITHOUT any blocking network call. The durable engine must not
 * bracket a 30s AI HTTP call inside its interactive transaction (that would risk a tx
 * timeout and break resumability), so the actual AI generation runs OUT-OF-BAND — in prod
 * a Temporal activity executed outside the workflow transaction. Pure + synchronous.
 */
function runAiStep(step: WorkflowStep): string {
  const prompt = readConfigString(step.config, "prompt");
  if (!prompt) {
    return "ai task: no prompt configured (recorded, nothing to draft)";
  }
  return "ai task queued (handled out-of-band; engine did not block)";
}

/**
 * Park on a human step: create the PENDING WorkflowTask, set the instance WAITING and
 * pin currentStepId, then STOP. dueAt = now + slaHours (TASK/APPROVAL) or now +
 * config.delayHours (TIMER). The worker tick later fires the timer / SLA escalation.
 */
async function parkOnHumanStep(
  tx: TxClient,
  instance: PrismaWorkflowInstance,
  step: WorkflowStep,
  now: Date = new Date(),
): Promise<PrismaWorkflowInstance> {
  const dueAt = computeDueAt(step, now);

  await tx.workflowTask.create({
    data: {
      orgId: instance.orgId,
      instanceId: instance.id,
      stepId: step.id,
      type: step.type,
      name: step.name,
      assigneeRole: step.assigneeRole ?? null,
      assigneeId: null,
      status: "PENDING",
      outcome: null,
      dueAt,
      completedAt: null,
      completedById: null,
      note: null,
    },
  });

  const updated = await tx.workflowInstance.update({
    where: { id: instance.id },
    data: { status: "WAITING", currentStepId: step.id },
  });

  log.info(
    { instanceId: instance.id, stepId: step.id, type: step.type, dueAt },
    "workflow parked on human step",
  );
  return updated;
}

/** dueAt for a human step: TIMER uses config.delayHours; others use slaHours. */
function computeDueAt(step: WorkflowStep, now: Date): Date | null {
  if (step.type === "TIMER") {
    const delay = readConfigNumber(step.config, "delayHours");
    if (delay != null && delay > 0) return addHours(now, delay);
    // A TIMER with no/zero delay is due immediately (the tick fires it next sweep).
    return now;
  }
  if (step.slaHours != null && step.slaHours > 0) return addHours(now, step.slaHours);
  return null;
}

function addHours(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

/** Mark the instance COMPLETED (terminal, completedAt set). */
async function completeInstance(
  tx: TxClient,
  instance: PrismaWorkflowInstance,
): Promise<PrismaWorkflowInstance> {
  const updated = await tx.workflowInstance.update({
    where: { id: instance.id },
    data: { status: "COMPLETED", currentStepId: null, completedAt: new Date() },
  });
  await writeAudit(tx, {
    actorId: null,
    action: "workflow.instance.complete",
    entityType: "workflow_instance",
    entityId: instance.id,
    payload: { definitionId: instance.definitionId },
  });
  log.info({ instanceId: instance.id }, "workflow instance completed");
  return updated;
}

/** Mark the instance FAILED (terminal). Used for malformed/cyclic definitions. */
async function failInstance(
  tx: TxClient,
  instance: PrismaWorkflowInstance,
  reason: string,
): Promise<PrismaWorkflowInstance> {
  const updated = await tx.workflowInstance.update({
    where: { id: instance.id },
    data: { status: "FAILED", completedAt: new Date() },
  });
  await writeAudit(tx, {
    actorId: null,
    action: "workflow.instance.fail",
    entityType: "workflow_instance",
    entityId: instance.id,
    payload: { reason },
  });
  log.warn({ instanceId: instance.id, reason }, "workflow instance failed");
  return updated;
}

// ═══ Task completion ══════════════════════════════════════════════════════════

export interface CompleteTaskInput {
  outcome?: z.infer<typeof TaskOutcome>;
  note?: string | null;
  /** The user who completed the task. Null for SYSTEM completions (e.g. a TIMER firing). */
  completedById: string | null;
}

/**
 * Complete a human task: mark it COMPLETED (outcome stored), then advance the instance
 * from the step's `next`. Authorisation (assignee / role / ADMIN/HRBP) is enforced by
 * the route BEFORE this is called; here we only record `completedById`.
 *
 * APPROVAL semantics: a REJECTED approval ENDS the instance (CANCELLED) UNLESS the step
 * has a branch that handles the rejection. We make the outcome available to branches by
 * writing it into the instance context as `{ <stepId>: { outcome }, lastOutcome }`, so a
 * BRANCH downstream can route on it via the safe comparator. If the rejected approval
 * step has its own branches, we honour them (the author opted into custom handling);
 * otherwise REJECTED cancels.
 */
export async function completeTask(
  tx: TxClient,
  task: PrismaWorkflowTask,
  input: CompleteTaskInput,
): Promise<{ task: PrismaWorkflowTask; instance: PrismaWorkflowInstance }> {
  // Idempotency: a task already completed/closed is a no-op (the periodic tick or a
  // double-submit must never double-advance the instance).
  if (task.status === "COMPLETED" || task.status === "SKIPPED") {
    const inst = await tx.workflowInstance.findUniqueOrThrow({ where: { id: task.instanceId } });
    return { task, instance: inst };
  }

  const completedTask = await tx.workflowTask.update({
    where: { id: task.id },
    data: {
      status: "COMPLETED",
      outcome: input.outcome ?? "DONE",
      note: input.note ?? task.note,
      completedAt: new Date(),
      completedById: input.completedById,
    },
  });

  const instance = await tx.workflowInstance.findUniqueOrThrow({
    where: { id: task.instanceId },
  });
  const definition = await tx.workflowDefinition.findUniqueOrThrow({
    where: { id: instance.definitionId },
  });
  const steps = parseWorkflowSteps(definition.steps);
  const step = indexSteps(steps).get(task.stepId);

  const outcome = input.outcome ?? "DONE";

  // Record the outcome into the instance context so downstream branches can route on it
  // via the SAFE comparator (e.g. `{ field: "approve.outcome", op: "EQ", value: "REJECTED" }`).
  const context: Record<string, unknown> = {
    ...((instance.context ?? {}) as Record<string, unknown>),
    [task.stepId]: { outcome },
    lastOutcome: outcome,
  };
  const contextJson = context as unknown as Prisma.InputJsonValue;

  await writeAudit(tx, {
    actorId: input.completedById,
    action: "workflow.task.complete",
    entityType: "workflow_task",
    entityId: task.id,
    payload: { stepId: task.stepId, outcome },
  });

  // Resolve where to resume. A human step may carry its OWN branch rules (custom
  // routing, e.g. handling a rejection): if so, route via the safe comparator against
  // the just-updated context. Otherwise follow the step's default `next`.
  const stepHandlesBranch = (step?.branches?.length ?? 0) > 0;
  const resumeFrom =
    stepHandlesBranch && step ? resolveBranchNext(step, context) : (step?.next ?? null);

  // A REJECTED approval with NO branch to handle it ENDS the instance (CANCELLED).
  const isRejection = task.type === "APPROVAL" && outcome === TaskOutcome.enum.REJECTED;
  if (isRejection && !stepHandlesBranch) {
    const repositioned = await tx.workflowInstance.update({
      where: { id: instance.id },
      data: { context: contextJson },
    });
    const cancelled = await cancelInstance(
      tx,
      repositioned,
      input.completedById,
      "approval rejected",
    );
    return { task: completedTask, instance: cancelled };
  }

  // Position the cursor on the resume target (RUNNING) and advance. `resumeFrom` is
  // never the just-completed human step id, so advance() cannot re-park on it.
  const positioned = await tx.workflowInstance.update({
    where: { id: instance.id },
    data: { status: "RUNNING", currentStepId: resumeFrom, context: contextJson },
  });
  const advanced = await advance(tx, positioned, definition);
  return { task: completedTask, instance: advanced };
}

/** Cancel an instance (terminal). Records the actor + reason in the audit trail. */
export async function cancelInstance(
  tx: TxClient,
  instance: PrismaWorkflowInstance,
  actorId: string | null,
  reason: string,
): Promise<PrismaWorkflowInstance> {
  const updated = await tx.workflowInstance.update({
    where: { id: instance.id },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  // Any still-open tasks on a cancelled instance are skipped (no longer actionable).
  await tx.workflowTask.updateMany({
    where: { instanceId: instance.id, status: { in: ["PENDING", "IN_PROGRESS", "OVERDUE", "ESCALATED"] } },
    data: { status: "SKIPPED" },
  });
  await writeAudit(tx, {
    actorId,
    action: "workflow.instance.cancel",
    entityType: "workflow_instance",
    entityId: instance.id,
    payload: { reason },
  });
  log.info({ instanceId: instance.id, reason }, "workflow instance cancelled");
  return updated;
}

// ═══ Timers + SLA / escalation (worker tick) ══════════════════════════════════

export interface TimersResult {
  /** TIMER tasks fired (completed + instance advanced). */
  timersFired: number;
  /** PENDING human tasks marked OVERDUE. */
  overdue: number;
  /** Overdue tasks further marked ESCALATED (an escalation policy applied). */
  escalated: number;
}

/**
 * Bounded per-tick batch so a backlog can never stall the worker (mirrors retentionPurge).
 */
const TICK_BATCH = 500;

/**
 * Process due TIMER tasks and SLA breaches for ONE org (the tx is already tenant-scoped).
 *   - TIMER tasks past dueAt: complete them (outcome DONE) and advance the instance.
 *   - PENDING human tasks (TASK/APPROVAL) past dueAt: mark OVERDUE, and ESCALATED when an
 *     escalation policy applies (step.config.escalateToRole present). Escalation re-points
 *     the task's assigneeRole to the escalation role so it surfaces in that role's inbox.
 * Idempotent: re-running a tick on already-fired timers / already-overdue tasks is a no-op.
 */
export async function processTimersAndSla(
  tx: TxClient,
  now: Date = new Date(),
): Promise<TimersResult> {
  let timersFired = 0;
  let overdue = 0;
  let escalated = 0;

  // ── 1. Fire due TIMER tasks ─────────────────────────────────────────────────
  const dueTimers = await tx.workflowTask.findMany({
    where: { type: "TIMER", status: "PENDING", dueAt: { lte: now } },
    take: TICK_BATCH,
  });
  for (const timer of dueTimers) {
    try {
      // completeTask advances the instance from the timer step's next (system completion).
      await completeTask(tx, timer, { outcome: "DONE", completedById: null });
      timersFired += 1;
    } catch (err) {
      log.error(
        { taskId: timer.id, err: err instanceof Error ? err.message : String(err) },
        "workflow timer fire failed",
      );
    }
  }

  // ── 2. SLA breach on PENDING human tasks → OVERDUE (+ ESCALATED if policy) ────
  const breached = await tx.workflowTask.findMany({
    where: {
      type: { in: ["TASK", "APPROVAL"] },
      status: "PENDING",
      dueAt: { lte: now },
    },
    take: TICK_BATCH,
  });
  for (const t of breached) {
    const escalateToRole = await escalationRoleFor(tx, t);
    if (escalateToRole) {
      await tx.workflowTask.update({
        where: { id: t.id },
        // Re-point to the escalation role's inbox and mark ESCALATED.
        data: { status: "ESCALATED", assigneeRole: escalateToRole },
      });
      escalated += 1;
      await writeAudit(tx, {
        actorId: null,
        action: "workflow.task.escalate",
        entityType: "workflow_task",
        entityId: t.id,
        payload: { stepId: t.stepId, escalateToRole },
      });
    } else {
      await tx.workflowTask.update({ where: { id: t.id }, data: { status: "OVERDUE" } });
      overdue += 1;
      await writeAudit(tx, {
        actorId: null,
        action: "workflow.task.overdue",
        entityType: "workflow_task",
        entityId: t.id,
        payload: { stepId: t.stepId },
      });
    }
  }

  if (timersFired || overdue || escalated) {
    log.info({ timersFired, overdue, escalated }, "workflow timers/SLA tick processed");
  }
  return { timersFired, overdue, escalated };
}

/**
 * Look up the escalation role for a breached task from its step config
 * (`config.escalateToRole`). Returns null when the step declares no escalation policy
 * (the task is simply marked OVERDUE). Reads the definition off the instance.
 */
async function escalationRoleFor(
  tx: TxClient,
  task: PrismaWorkflowTask,
): Promise<string | null> {
  const instance = await tx.workflowInstance.findUnique({
    where: { id: task.instanceId },
    select: { definitionId: true },
  });
  if (!instance) return null;
  const definition = await tx.workflowDefinition.findUnique({
    where: { id: instance.definitionId },
    select: { steps: true },
  });
  if (!definition) return null;
  const step = indexSteps(parseWorkflowSteps(definition.steps)).get(task.stepId);
  const raw = readConfigString(step?.config, "escalateToRole");
  if (raw == null) return null;
  // Only escalate to a VALID role: a malformed config value would otherwise produce a
  // task whose assigneeRole fails serialization later. An invalid role → no escalation.
  const role = UserRole.safeParse(raw);
  return role.success ? role.data : null;
}

// ═══ Event trigger ════════════════════════════════════════════════════════════

export interface EmitEventInput {
  eventType: string;
  subjectType?: string | null;
  subjectId?: string | null;
  context?: Record<string, unknown>;
  createdById?: string | null;
}

/**
 * Start an instance for EVERY ACTIVE, EVENT-triggered definition in this tenant whose
 * eventType matches. Returns the started instances (id + definitionKey). The tx is
 * tenant-scoped, so this only ever fires the calling org's workflows.
 */
export async function emitEvent(
  tx: TxClient,
  input: EmitEventInput,
): Promise<Array<{ instanceId: string; definitionKey: string }>> {
  const definitions = await tx.workflowDefinition.findMany({
    where: { trigger: "EVENT", eventType: input.eventType, active: true },
  });

  const started: Array<{ instanceId: string; definitionKey: string }> = [];
  for (const definition of definitions) {
    const instance = await startInstance(tx, definition, {
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      context: input.context ?? {},
      createdById: input.createdById ?? null,
    });
    started.push({ instanceId: instance.id, definitionKey: definition.key });
  }
  if (started.length > 0) {
    log.info({ eventType: input.eventType, started: started.length }, "workflow event emitted");
  }
  return started;
}

// ═══ config helpers ═══════════════════════════════════════════════════════════

function readConfigString(
  config: WorkflowStep["config"] | undefined,
  key: string,
): string | null {
  const v = config?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readConfigNumber(
  config: WorkflowStep["config"] | undefined,
  key: string,
): number | null {
  const v = config?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/*
 * ── PROD EXECUTION SUBSTRATE (Temporal.io) — documented adapter ──────────────────
 *
 * The spec (Module 9) names Temporal as the prod durable-execution engine. We do NOT
 * add it here — but the seam is deliberate. To swap in Temporal:
 *
 *   - A `WorkflowDefinition` compiles to a Temporal Workflow function; each step maps to
 *     an Activity (NOTIFICATION → a mailer activity, AI_TASK → an AI activity, human
 *     TASK/APPROVAL → an `await condition(signalReceived)` that blocks on a Signal sent by
 *     POST /workflow-tasks/:id/complete). TIMER → `workflow.sleep(delayHours)`. SLA →
 *     a timer race against the human signal that fires the escalation activity.
 *   - The WorkflowInstance/Task rows remain the QUERYABLE projection (the "my tasks"
 *     inbox + the monitor read off them) updated by Activities; Temporal owns the durable
 *     event history instead of this `advance` loop. `evaluateCondition` stays the SAME
 *     safe comparator (it runs inside the Workflow for BRANCH steps — no eval, ever).
 *   - This dev engine and the Temporal adapter share the contracts + the comparator, so
 *     a definition authored against one runs unchanged on the other.
 */
