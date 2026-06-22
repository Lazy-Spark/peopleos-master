import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  CompleteTaskRequest,
  CreateWorkflowDefinitionRequest,
  DraftWorkflowRequest,
  DraftWorkflowResponse,
  EmitEventRequest,
  EmitEventResponse,
  InstanceStatus,
  StartWorkflowRequest,
  UserRole,
  WorkflowDefinition,
  WorkflowInstanceDetail,
  WorkflowInstanceSummary,
  WorkflowMonitor,
  WorkflowTask,
  type WorkflowInstanceDetail as TWorkflowInstanceDetail,
  type WorkflowStep as TWorkflowStep,
} from "@peopleos/schemas";
import type {
  Prisma,
  WorkflowDefinition as PrismaWorkflowDefinition,
  WorkflowInstance as PrismaWorkflowInstance,
} from "@prisma/client";
import { withTenant, type TxClient } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import type { AuthContext } from "../plugins/auth.js";
import { writeAudit } from "../lib/audit.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { aiClient } from "../lib/aiClient.js";
import { buildOrgContext } from "../lib/orgContext.js";
import {
  serializeWorkflowDefinition,
  serializeWorkflowInstance,
  serializeWorkflowTask,
} from "../lib/serialize.js";
import {
  cancelInstance,
  completeTask,
  emitEvent,
  startInstance,
} from "../lib/workflowEngine.js";

/**
 * Module 9 — Workflow Automation routes. Mounted under /api/v1, tenant-scoped via
 * requireTenant + withTenant(orgId) (RLS isolates all workflow data per org).
 *
 *   GET   /workflow-definitions               WorkflowDefinition[]
 *   GET   /workflow-definitions/:id           WorkflowDefinition
 *   POST  /workflow-definitions               create a definition   (ADMIN/HRBP)
 *   POST  /workflow-definitions/draft         AI draft (does NOT persist) (ADMIN/HRBP)
 *   POST  /workflow-definitions/:id/start     start an instance     (ADMIN/HRBP/MANAGER)
 *   GET   /workflow-instances                 WorkflowInstanceSummary[]
 *   GET   /workflow-instances/:id             WorkflowInstanceDetail
 *   POST  /workflow-instances/:id/cancel      cancel a running instance
 *   GET   /workflow-tasks?mine=1              the caller's task inbox
 *   POST  /workflow-tasks/:id/complete        complete a task (assignee/role/ADMIN/HRBP)
 *   POST  /workflow-events                    emit an event → start matching instances (ADMIN/HRBP)
 *   GET   /workflow-monitor                   org-wide workflow health (ADMIN/HRBP)
 *
 * DESIGN: the engine (src/lib/workflowEngine.ts) is the durable DB-persisted state
 * machine; these routes are thin tenant-guarded entry points into it. Every query goes
 * through withTenant; every create sets orgId; the engine is idempotent under the tick.
 */

const IdParam = z.object({ id: z.string().uuid() });
const TaskIdParam = z.object({ id: z.string().uuid() });

const DefinitionListResponse = z.object({ items: z.array(WorkflowDefinition) });
const InstanceListResponse = z.object({ items: z.array(WorkflowInstanceSummary) });
const TaskListResponse = z.object({ items: z.array(WorkflowTask) });

const InstanceListQuery = z.object({
  status: InstanceStatus.optional(),
  definitionId: z.string().uuid().optional(),
});
const TaskListQuery = z.object({
  mine: z.coerce.boolean().optional(),
  status: z.string().optional(),
});

/** Roles that may author / start / administer workflows. */
const AUTHOR_ROLES = new Set<z.infer<typeof UserRole>>(["ADMIN", "HRBP"]);
const START_ROLES = new Set<z.infer<typeof UserRole>>(["ADMIN", "HRBP", "MANAGER"]);

/**
 * Validate the step DAG of a CreateWorkflowDefinitionRequest BEYOND what Zod can check:
 *   - step ids are unique;
 *   - every `next` target references a real step id;
 *   - every BRANCH rule `next` target references a real step id.
 * Throws a clean 400 (badRequest) on the first violation. The frozen WorkflowStep schema
 * already guarantees each step's shape (type enum, non-empty id/name, etc.).
 */
function validateStepGraph(steps: TWorkflowStep[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw badRequest(`Duplicate step id "${step.id}".`);
    }
    ids.add(step.id);
  }
  for (const step of steps) {
    if (step.next != null && !ids.has(step.next)) {
      throw badRequest(`Step "${step.id}" points next to unknown step "${step.next}".`);
    }
    for (const rule of step.branches ?? []) {
      if (!ids.has(rule.next)) {
        throw badRequest(
          `BRANCH step "${step.id}" routes to unknown step "${rule.next}".`,
        );
      }
    }
  }
}

/** Assemble the WorkflowInstanceDetail (instance + definition key/name + tasks). */
async function loadInstanceDetail(
  tx: TxClient,
  instance: PrismaWorkflowInstance,
  definition: PrismaWorkflowDefinition,
): Promise<TWorkflowInstanceDetail> {
  const tasks = await tx.workflowTask.findMany({
    where: { instanceId: instance.id },
    orderBy: { createdAt: "asc" },
  });
  return WorkflowInstanceDetail.parse({
    ...serializeWorkflowInstance(instance),
    definitionKey: definition.key,
    definitionName: definition.name,
    tasks: tasks.map(serializeWorkflowTask),
  });
}

/**
 * Resolve the caller's internal User.id (prod: map Clerk id → User.id; dev: the principal
 * IS the User.id). Used for "mine" task filtering + recording completedById.
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

const workflowRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── List definitions ─────────────────────────────────────────────────────────
  r.get(
    "/workflow-definitions",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "List workflow definitions (Module 9).",
        description:
          "Every workflow template in the org (newest first). A definition is a DAG of steps with a trigger (MANUAL/EVENT/SCHEDULED).",
        response: { 200: DefinitionListResponse, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      return withTenant(orgId, async (tx) => {
        const rows = await tx.workflowDefinition.findMany({
          orderBy: { createdAt: "desc" },
        });
        return { items: rows.map(serializeWorkflowDefinition) };
      });
    },
  );

  // ── Get one definition ───────────────────────────────────────────────────────
  r.get(
    "/workflow-definitions/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "Get a workflow definition (Module 9).",
        params: IdParam,
        response: { 200: WorkflowDefinition, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;
      return withTenant(orgId, async (tx) => {
        const row = await tx.workflowDefinition.findUnique({ where: { id } });
        if (!row) throw notFound(`Workflow definition ${id} not found`);
        return serializeWorkflowDefinition(row);
      });
    },
  );

  // ── Create a definition (ADMIN/HRBP) ──────────────────────────────────────────
  r.post(
    "/workflow-definitions",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "Create a workflow definition (Module 9) — ADMIN/HRBP.",
        description:
          "Authors a new workflow template. Beyond the frozen WorkflowStep schema, the step DAG is validated: step ids must be unique and every `next` / BRANCH target must reference a real step id (400 otherwise). version defaults to 1, active to true. createdById records the author. 409 if (key, version) already exists.",
        body: CreateWorkflowDefinitionRequest,
        response: {
          201: WorkflowDefinition,
          400: ApiError,
          401: ApiError,
          403: ApiError,
          409: ApiError,
        },
      },
    },
    async (request, reply) => {
      const { orgId, userId, role } = tenant(request);
      if (!AUTHOR_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may create a workflow definition.");
      }
      const body = request.body;
      // Validate the DAG before persisting (unique ids + resolvable targets).
      validateStepGraph(body.steps);

      const created = await withTenant(orgId, async (tx) => {
        const definition = await tx.workflowDefinition.create({
          data: {
            orgId,
            key: body.key,
            name: body.name,
            description: body.description ?? null,
            trigger: body.trigger,
            eventType: body.eventType ?? null,
            schedule: body.schedule ?? null,
            // Stored as the contract shape; serialized back through WorkflowStep on read.
            steps: body.steps as unknown as Prisma.InputJsonValue,
            version: 1,
            active: true,
            createdById: userId,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "workflow.definition.create",
          entityType: "workflow_definition",
          entityId: definition.id,
          payload: { key: definition.key, trigger: definition.trigger, steps: body.steps.length },
          ip: request.ip,
        });
        return definition;
      });

      return reply.code(201).send(serializeWorkflowDefinition(created));
    },
  );

  // ── AI draft a definition (does NOT persist) (ADMIN/HRBP) ─────────────────────
  r.post(
    "/workflow-definitions/draft",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "AI-draft a workflow from a description (Module 9) — ADMIN/HRBP.",
        description:
          "Passthrough to the AI service (Claude claude-sonnet-4-6): a plain-language description → a structured WorkflowDefinition skeleton (name, trigger, steps, confidence). The orgId is taken from the authenticated session (never the client body); the org's prompt context is attached. The draft is ADVISORY and is NOT persisted — a human reviews it and submits it via POST /workflow-definitions. 502 if the AI service is unavailable.",
        // The client sends only { description } (+ optional orgContext); the orgId is
        // ALWAYS taken from the session, never the body — omit it from the request schema.
        body: DraftWorkflowRequest.omit({ orgId: true }),
        response: {
          200: DraftWorkflowResponse,
          400: ApiError,
          401: ApiError,
          403: ApiError,
          502: ApiError,
        },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      if (!AUTHOR_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may draft a workflow.");
      }
      // The org context is built server-side; the orgId ALWAYS comes from the session.
      const orgContext = await withTenant(orgId, async (tx) => {
        const org = await tx.organisation.findUnique({ where: { id: orgId } });
        return buildOrgContext(org, role);
      });
      return aiClient.draftWorkflow({
        orgId,
        description: request.body.description,
        orgContext,
      });
    },
  );

  // ── Start an instance (ADMIN/HRBP/MANAGER) ────────────────────────────────────
  r.post(
    "/workflow-definitions/:id/start",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "Start a workflow instance (Module 9) — ADMIN/HRBP/MANAGER.",
        description:
          "Creates a RUNNING instance of the definition and advances it through any leading auto steps (NOTIFICATION/AI_TASK/BRANCH), parking on the first human step (TASK/APPROVAL/TIMER) or completing. Returns the resulting WorkflowInstanceDetail (the instance is never observed RUNNING at rest). 404 if the definition is not in this tenant; 400 if it is inactive.",
        params: IdParam,
        body: StartWorkflowRequest,
        response: {
          201: WorkflowInstanceDetail,
          400: ApiError,
          401: ApiError,
          403: ApiError,
          404: ApiError,
        },
      },
    },
    async (request, reply) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      if (!START_ROLES.has(role)) {
        throw forbidden("Only ADMIN, HRBP, or MANAGER roles may start a workflow.");
      }
      const { id } = request.params;
      const body = request.body;

      const detail = await withTenant(orgId, async (tx) => {
        const definition = await tx.workflowDefinition.findUnique({ where: { id } });
        if (!definition) throw notFound(`Workflow definition ${id} not found`);
        if (!definition.active) {
          throw badRequest("Cannot start an inactive workflow definition.");
        }
        const userId = await resolveUserId(tx, auth);
        const instance = await startInstance(tx, definition, {
          subjectType: body.subjectType ?? null,
          subjectId: body.subjectId ?? null,
          context: body.context ?? {},
          createdById: userId,
        });
        return loadInstanceDetail(tx, instance, definition);
      });

      return reply.code(201).send(detail);
    },
  );

  // ── List instances ────────────────────────────────────────────────────────────
  r.get(
    "/workflow-instances",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "List workflow instances (Module 9).",
        description:
          "Workflow instances in the org (newest first), optionally filtered by status or definitionId. Returns lightweight WorkflowInstanceSummary rows (use GET /workflow-instances/:id for the full detail incl. tasks).",
        querystring: InstanceListQuery,
        response: { 200: InstanceListResponse, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { status, definitionId } = request.query;
      return withTenant(orgId, async (tx) => {
        const rows = await tx.workflowInstance.findMany({
          where: {
            ...(status ? { status } : {}),
            ...(definitionId ? { definitionId } : {}),
          },
          include: { definition: { select: { key: true, name: true } } },
          orderBy: { startedAt: "desc" },
          take: 200,
        });
        const items = rows.map((row) =>
          WorkflowInstanceSummary.parse({
            id: row.id,
            definitionKey: row.definition.key,
            definitionName: row.definition.name,
            status: InstanceStatus.parse(row.status),
            subjectId: row.subjectId,
            currentStepId: row.currentStepId,
            startedAt: row.startedAt.toISOString(),
          }),
        );
        return { items };
      });
    },
  );

  // ── Get one instance (detail) ──────────────────────────────────────────────────
  r.get(
    "/workflow-instances/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "Get a workflow instance with its tasks (Module 9).",
        params: IdParam,
        response: { 200: WorkflowInstanceDetail, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;
      return withTenant(orgId, async (tx) => {
        const instance = await tx.workflowInstance.findUnique({ where: { id } });
        if (!instance) throw notFound(`Workflow instance ${id} not found`);
        const definition = await tx.workflowDefinition.findUniqueOrThrow({
          where: { id: instance.definitionId },
        });
        return loadInstanceDetail(tx, instance, definition);
      });
    },
  );

  // ── Cancel an instance ──────────────────────────────────────────────────────────
  r.post(
    "/workflow-instances/:id/cancel",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "Cancel a running workflow instance (Module 9) — ADMIN/HRBP/MANAGER.",
        description:
          "Marks a RUNNING/WAITING instance CANCELLED (terminal) and skips its open tasks. A no-op (returns the current detail) if the instance is already terminal. 404 if not in this tenant.",
        params: IdParam,
        response: {
          200: WorkflowInstanceDetail,
          401: ApiError,
          403: ApiError,
          404: ApiError,
        },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      if (!START_ROLES.has(role)) {
        throw forbidden("Only ADMIN, HRBP, or MANAGER roles may cancel a workflow.");
      }
      const { id } = request.params;
      return withTenant(orgId, async (tx) => {
        const instance = await tx.workflowInstance.findUnique({ where: { id } });
        if (!instance) throw notFound(`Workflow instance ${id} not found`);
        const definition = await tx.workflowDefinition.findUniqueOrThrow({
          where: { id: instance.definitionId },
        });
        const isTerminal =
          instance.status === "COMPLETED" ||
          instance.status === "FAILED" ||
          instance.status === "CANCELLED";
        if (isTerminal) {
          return loadInstanceDetail(tx, instance, definition);
        }
        const userId = await resolveUserId(tx, auth);
        const cancelled = await cancelInstance(tx, instance, userId, "cancelled by user");
        return loadInstanceDetail(tx, cancelled, definition);
      });
    },
  );

  // ── My tasks inbox ──────────────────────────────────────────────────────────────
  r.get(
    "/workflow-tasks",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "List workflow tasks — the caller's inbox (Module 9).",
        description:
          "With `mine=1`, returns the OPEN tasks (PENDING/IN_PROGRESS/OVERDUE/ESCALATED) assigned to the caller: tasks directly assigned to them (assigneeId) OR assigned to their role (assigneeRole). Without `mine`, ADMIN/HRBP see all tasks in the org (others get only their own). Optional `status` filter. Newest first.",
        querystring: TaskListQuery,
        response: { 200: TaskListResponse, 401: ApiError },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      const { mine, status } = request.query;

      return withTenant(orgId, async (tx) => {
        const userId = await resolveUserId(tx, auth);
        const seeAll = !mine && AUTHOR_ROLES.has(role);

        const where: Prisma.WorkflowTaskWhereInput = {
          ...(status ? { status } : {}),
          // The inbox view: tasks assigned directly to the caller OR to their role.
          ...(seeAll ? {} : { OR: [{ assigneeId: userId }, { assigneeRole: role }] }),
        };

        const rows = await tx.workflowTask.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: 200,
        });
        return { items: rows.map(serializeWorkflowTask) };
      });
    },
  );

  // ── Complete a task ───────────────────────────────────────────────────────────
  r.post(
    "/workflow-tasks/:id/complete",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "Complete a workflow task (Module 9).",
        description:
          "Authorisation: ONLY the task's direct assignee (assigneeId), a holder of the task's assigneeRole, or an ADMIN/HRBP may complete it — else 403. The task is marked COMPLETED (outcome stored) and the instance advances from the step's next. A REJECTED APPROVAL ends the instance (CANCELLED) unless the step declares a branch that handles it. 404 if the task is not in this tenant; 409 if it is already completed/closed.",
        params: TaskIdParam,
        body: CompleteTaskRequest,
        response: {
          200: WorkflowInstanceDetail,
          400: ApiError,
          401: ApiError,
          403: ApiError,
          404: ApiError,
          409: ApiError,
        },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      const { id } = request.params;
      const body = request.body;

      return withTenant(orgId, async (tx) => {
        const task = await tx.workflowTask.findUnique({ where: { id } });
        if (!task) throw notFound(`Workflow task ${id} not found`);

        const userId = await resolveUserId(tx, auth);

        // Authorisation: direct assignee, role holder, or ADMIN/HRBP.
        const isAssignee = task.assigneeId != null && task.assigneeId === userId;
        const isRoleHolder = task.assigneeRole != null && task.assigneeRole === role;
        const isAdmin = AUTHOR_ROLES.has(role);
        if (!isAssignee && !isRoleHolder && !isAdmin) {
          throw forbidden("You are not authorised to complete this task.");
        }

        // Only open human tasks are completable; auto/closed tasks are a clean 409/400.
        if (task.status === "COMPLETED" || task.status === "SKIPPED") {
          throw badRequest("This task is already completed.");
        }
        if (task.type === "NOTIFICATION" || task.type === "AI_TASK" || task.type === "BRANCH") {
          throw badRequest("Auto steps are not completable by a user.");
        }

        const { instance } = await completeTask(tx, task, {
          outcome: body.outcome,
          note: body.note ?? null,
          completedById: userId,
        });
        const definition = await tx.workflowDefinition.findUniqueOrThrow({
          where: { id: instance.definitionId },
        });
        return loadInstanceDetail(tx, instance, definition);
      });
    },
  );

  // ── Emit an event (ADMIN/HRBP) ────────────────────────────────────────────────
  r.post(
    "/workflow-events",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "Emit a workflow event (Module 9) — ADMIN/HRBP.",
        description:
          "Starts an instance for EVERY ACTIVE, EVENT-triggered definition in the org whose eventType matches (e.g. `employee.created`). Returns the started instances (id + definitionKey). The event is tenant-scoped — it only fires this org's workflows.",
        body: EmitEventRequest,
        response: { 200: EmitEventResponse, 401: ApiError, 403: ApiError },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      if (!AUTHOR_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may emit a workflow event.");
      }
      const body = request.body;

      return withTenant(orgId, async (tx) => {
        const userId = await resolveUserId(tx, auth);
        const started = await emitEvent(tx, {
          eventType: body.eventType,
          subjectType: body.subjectType ?? null,
          subjectId: body.subjectId ?? null,
          context: body.context ?? {},
          createdById: userId,
        });
        return EmitEventResponse.parse({ started });
      });
    },
  );

  // ── Monitor (ADMIN/HRBP) ──────────────────────────────────────────────────────
  r.get(
    "/workflow-monitor",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["workflow"],
        summary: "Workflow monitoring dashboard (Module 9) — ADMIN/HRBP.",
        description:
          "Org-wide workflow health: instance counts by status, the number of overdue/escalated tasks, and the 20 most recent instances. Used to spot stuck or breaching workflows.",
        response: { 200: WorkflowMonitor, 401: ApiError, 403: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      if (!AUTHOR_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may view the workflow monitor.");
      }
      return withTenant(orgId, async (tx) => {
        const grouped = await tx.workflowInstance.groupBy({
          by: ["status"],
          _count: { _all: true },
        });
        const byStatus = grouped.map((g) => ({
          status: InstanceStatus.parse(g.status),
          count: g._count._all,
        }));

        const overdueTasks = await tx.workflowTask.count({
          where: { status: { in: ["OVERDUE", "ESCALATED"] } },
        });

        const recentRows = await tx.workflowInstance.findMany({
          include: { definition: { select: { key: true, name: true } } },
          orderBy: { startedAt: "desc" },
          take: 20,
        });
        const recentInstances = recentRows.map((row) =>
          WorkflowInstanceSummary.parse({
            id: row.id,
            definitionKey: row.definition.key,
            definitionName: row.definition.name,
            status: InstanceStatus.parse(row.status),
            subjectId: row.subjectId,
            currentStepId: row.currentStepId,
            startedAt: row.startedAt.toISOString(),
          }),
        );

        return WorkflowMonitor.parse({ byStatus, overdueTasks, recentInstances });
      });
    },
  );
};

export default workflowRoutes;
