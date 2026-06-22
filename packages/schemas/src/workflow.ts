import { z } from "zod";
import { OrgContext } from "./ai.js";
import { IsoDateTime, OrgId, UserId, UserRole } from "./common.js";

/**
 * Module 9 — Workflow Automation Engine contracts.
 *
 * HR processes are modelled as a durable state machine (the dev engine over Postgres;
 * Temporal is the documented prod execution substrate). A WorkflowDefinition is a DAG of
 * steps; an instance walks it, creating a WorkflowTask for each human step. camelCase
 * end-to-end; the AI draft-authoring surface is mirrored as Pydantic.
 */

// ═══ Enums ═══════════════════════════════════════════════════════════════════
export const WorkflowTrigger = z.enum(["MANUAL", "EVENT", "SCHEDULED"]);
export type WorkflowTrigger = z.infer<typeof WorkflowTrigger>;

/** Auto steps (NOTIFICATION/AI_TASK/BRANCH) run inline; human steps (TASK/APPROVAL/TIMER) wait. */
export const StepType = z.enum(["TASK", "APPROVAL", "NOTIFICATION", "AI_TASK", "TIMER", "BRANCH"]);
export type StepType = z.infer<typeof StepType>;

export const InstanceStatus = z.enum([
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type InstanceStatus = z.infer<typeof InstanceStatus>;

export const TaskStatus = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "SKIPPED",
  "ESCALATED",
  "OVERDUE",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskOutcome = z.enum(["APPROVED", "REJECTED", "DONE"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

export const BranchOp = z.enum(["EQ", "NE", "EXISTS", "GT", "LT"]);
export type BranchOp = z.infer<typeof BranchOp>;

// ═══ Step DAG ════════════════════════════════════════════════════════════════
/** A SAFE, declarative branch predicate over instance context — never an eval'd string. */
export const BranchCondition = z.object({
  field: z.string(),
  op: BranchOp,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});
export type BranchCondition = z.infer<typeof BranchCondition>;

export const BranchRule = z.object({ when: BranchCondition, next: z.string() });
export type BranchRule = z.infer<typeof BranchRule>;

export const WorkflowStep = z.object({
  id: z.string().min(1),
  type: StepType,
  name: z.string().min(1),
  /** Who owns a human step (TASK/APPROVAL). */
  assigneeRole: UserRole.optional(),
  /** Hours until the step's task is due (drives SLA / escalation). */
  slaHours: z.number().int().positive().optional(),
  /** Type-specific config (AI_TASK.prompt, NOTIFICATION.template, TIMER.delayHours, …). */
  config: z.record(z.unknown()).optional(),
  /** Default next step id; null/absent = terminal (unless branches match). */
  next: z.string().nullable().optional(),
  /** For BRANCH: ordered rules; the first matching rule's `next` is taken. */
  branches: z.array(BranchRule).optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

// ═══ Definition ══════════════════════════════════════════════════════════════
export const WorkflowDefinition = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  trigger: WorkflowTrigger,
  eventType: z.string().nullable(),
  schedule: z.string().nullable(),
  steps: z.array(WorkflowStep),
  version: z.number().int().positive(),
  active: z.boolean(),
  createdById: UserId.nullable(),
  createdAt: IsoDateTime,
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export const CreateWorkflowDefinitionRequest = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  trigger: WorkflowTrigger,
  eventType: z.string().nullable().optional(),
  schedule: z.string().nullable().optional(),
  steps: z.array(WorkflowStep).min(1),
});
export type CreateWorkflowDefinitionRequest = z.infer<typeof CreateWorkflowDefinitionRequest>;

// ═══ Instance + tasks ════════════════════════════════════════════════════════
export const WorkflowInstance = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  definitionId: z.string().uuid(),
  status: InstanceStatus,
  subjectType: z.string().nullable(),
  subjectId: z.string().uuid().nullable(),
  currentStepId: z.string().nullable(),
  context: z.record(z.unknown()),
  startedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
});
export type WorkflowInstance = z.infer<typeof WorkflowInstance>;

export const WorkflowTask = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  instanceId: z.string().uuid(),
  stepId: z.string(),
  type: StepType,
  name: z.string(),
  assigneeRole: UserRole.nullable(),
  assigneeId: z.string().uuid().nullable(),
  status: TaskStatus,
  outcome: TaskOutcome.nullable(),
  dueAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  completedById: UserId.nullable(),
  note: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type WorkflowTask = z.infer<typeof WorkflowTask>;

export const WorkflowInstanceDetail = WorkflowInstance.extend({
  definitionKey: z.string(),
  definitionName: z.string(),
  tasks: z.array(WorkflowTask),
});
export type WorkflowInstanceDetail = z.infer<typeof WorkflowInstanceDetail>;

// ═══ Requests ════════════════════════════════════════════════════════════════
export const StartWorkflowRequest = z.object({
  subjectType: z.string().optional(),
  subjectId: z.string().uuid().optional(),
  context: z.record(z.unknown()).optional(),
});
export type StartWorkflowRequest = z.infer<typeof StartWorkflowRequest>;

export const CompleteTaskRequest = z.object({
  outcome: TaskOutcome.optional(),
  note: z.string().max(2000).optional(),
});
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequest>;

export const EmitEventRequest = z.object({
  eventType: z.string().min(1),
  subjectType: z.string().optional(),
  subjectId: z.string().uuid().optional(),
  context: z.record(z.unknown()).optional(),
});
export type EmitEventRequest = z.infer<typeof EmitEventRequest>;

export const EmitEventResponse = z.object({
  started: z.array(z.object({ instanceId: z.string().uuid(), definitionKey: z.string() })),
});
export type EmitEventResponse = z.infer<typeof EmitEventResponse>;

// ═══ Monitoring ══════════════════════════════════════════════════════════════
export const InstanceStatusCount = z.object({
  status: InstanceStatus,
  count: z.number().int().nonnegative(),
});
export type InstanceStatusCount = z.infer<typeof InstanceStatusCount>;

export const WorkflowInstanceSummary = z.object({
  id: z.string().uuid(),
  definitionKey: z.string(),
  definitionName: z.string(),
  status: InstanceStatus,
  subjectId: z.string().uuid().nullable(),
  currentStepId: z.string().nullable(),
  startedAt: IsoDateTime,
});
export type WorkflowInstanceSummary = z.infer<typeof WorkflowInstanceSummary>;

export const WorkflowMonitor = z.object({
  byStatus: z.array(InstanceStatusCount),
  overdueTasks: z.number().int().nonnegative(),
  recentInstances: z.array(WorkflowInstanceSummary),
});
export type WorkflowMonitor = z.infer<typeof WorkflowMonitor>;

// ═══ AI: draft a workflow from a description ═════════════════════════════════
export const DraftWorkflowRequest = z.object({
  orgId: OrgId,
  description: z.string().min(1),
  orgContext: OrgContext.optional(),
});
export type DraftWorkflowRequest = z.infer<typeof DraftWorkflowRequest>;

export const DraftWorkflowResponse = z.object({
  name: z.string(),
  trigger: WorkflowTrigger,
  eventType: z.string().nullable(),
  steps: z.array(WorkflowStep),
  confidence: z.enum(["low", "medium", "high"]),
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type DraftWorkflowResponse = z.infer<typeof DraftWorkflowResponse>;
