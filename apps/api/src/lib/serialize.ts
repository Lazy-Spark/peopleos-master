import type {
  Application as PrismaApplication,
  Candidate as PrismaCandidate,
  ChatMessage as PrismaChatMessage,
  HrTicket as PrismaHrTicket,
  Interview as PrismaInterview,
  JobOpening as PrismaJobOpening,
  PolicyDocument as PrismaPolicyDocument,
  Scorecard as PrismaScorecard,
  WorkflowDefinition as PrismaWorkflowDefinition,
  WorkflowInstance as PrismaWorkflowInstance,
  WorkflowTask as PrismaWorkflowTask,
} from "@prisma/client";
import { z } from "zod";
import {
  AiScorecardDraft,
  Application,
  ApplicationAiRanking,
  CalibrationFlag,
  Candidate,
  CandidateProfile,
  ChatMessageRecord,
  Citation,
  HrTicket,
  InterviewScorecard,
  InstanceStatus,
  JDStructured,
  JobOpening,
  PolicyDocument,
  PolicyDocType,
  PolicyStatus,
  StepType,
  TaskOutcome,
  TaskStatus,
  UserRole,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowStep,
  WorkflowTask,
  WorkflowTrigger,
  type Application as TApplication,
  type Candidate as TCandidate,
  type ChatMessageRecord as TChatMessageRecord,
  type HrTicket as THrTicket,
  type InterviewScorecard as TInterviewScorecard,
  type JobOpening as TJobOpening,
  type PolicyDocument as TPolicyDocument,
  type WorkflowDefinition as TWorkflowDefinition,
  type WorkflowInstance as TWorkflowInstance,
  type WorkflowStep as TWorkflowStep,
  type WorkflowTask as TWorkflowTask,
} from "@peopleos/schemas";

/**
 * Prisma → wire serializers. Prisma returns `Date` objects and untyped `Json`
 * columns; the wire contract (and the route response schemas) expect ISO strings
 * and validated nested objects. These helpers map + validate so every response
 * conforms to @peopleos/schemas before it leaves the API (no `any`, no leakage of
 * DB-only columns such as CandidateRanking.reasoning).
 */

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);
/** A Prisma `@db.Date` column → the wire `IsoDate` (YYYY-MM-DD), or null. */
const isoDateOrNull = (d: Date | null): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

export function serializeJob(row: PrismaJobOpening): TJobOpening {
  return JobOpening.parse({
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    department: row.department,
    level: row.level,
    location: row.location,
    type: row.type,
    status: row.status,
    jdText: row.jdText,
    jdStructured: row.jdStructured == null ? null : JDStructured.parse(row.jdStructured),
    hiringManagerId: row.hiringManagerId,
    recruiterId: row.recruiterId,
    scorecardTemplateId: row.scorecardTemplateId,
    createdAt: iso(row.createdAt),
    closedAt: isoOrNull(row.closedAt),
  });
}

export function serializeCandidate(row: PrismaCandidate): TCandidate {
  return Candidate.parse({
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    linkedinUrl: row.linkedinUrl,
    githubUrl: row.githubUrl,
    source: row.source,
    resumeFilePath: row.resumeFilePath,
    resumeParsedAt: isoOrNull(row.resumeParsedAt),
    profile: row.profile == null ? null : CandidateProfile.parse(row.profile),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

export function serializeApplication(row: PrismaApplication): TApplication {
  return Application.parse({
    id: row.id,
    orgId: row.orgId,
    candidateId: row.candidateId,
    jobId: row.jobId,
    stage: row.stage,
    status: row.status,
    aiRanking: row.aiRanking == null ? null : ApplicationAiRanking.parse(row.aiRanking),
    appliedAt: iso(row.appliedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

// ── Module 3 — Interview Intelligence ─────────────────────────────────────────

/** The persisted `competency_scores` JSON column shape (human/reviewer scores). */
const StoredCompetencyScores = z
  .array(
    z.object({
      competencyId: z.string(),
      score: z.number().int(),
      evidence: z.string().nullable().default(null),
    }),
  )
  .default([]);

/**
 * Loosely read the per-interview AI calibration flags out of the stored
 * `ai_scorecard_draft` blob. We persist `{ ...draft, competencyEvidence,
 * calibrationFlags }` in that column (the draft contract proper has no flags field),
 * so on the way out we split it: the `AiScorecardDraft` contract parse strips the
 * extra `competencyEvidence`/`calibrationFlags` keys, and we surface the flags on the
 * top-level `calibrationFlags` field of `InterviewScorecard`.
 */
const StoredDraftEnvelope = z
  .object({ calibrationFlags: z.array(CalibrationFlag).optional() })
  .passthrough();

/**
 * Prisma `Scorecard` row → the frozen `InterviewScorecard` wire contract. The raw
 * interview transcript is NEVER part of this shape — only evidence quotes that the AI
 * embedded inside the draft. Validates against the contract before returning so no
 * DB-only field can leak.
 */
export function serializeScorecard(row: PrismaScorecard): TInterviewScorecard {
  const draftEnvelope =
    row.aiScorecardDraft == null ? null : StoredDraftEnvelope.parse(row.aiScorecardDraft);
  const aiScorecardDraft =
    row.aiScorecardDraft == null ? null : AiScorecardDraft.parse(row.aiScorecardDraft);
  const calibrationFlags = draftEnvelope?.calibrationFlags ?? [];

  return InterviewScorecard.parse({
    id: row.id,
    interviewId: row.interviewId,
    applicationId: row.applicationId,
    reviewerId: row.reviewerId,
    competencyScores: StoredCompetencyScores.parse(row.competencyScores),
    overall: row.overall,
    aiSummary: row.aiSummary,
    aiScorecardDraft,
    calibrationFlags,
    submittedAt: isoOrNull(row.submittedAt),
  });
}

/**
 * A privacy-safe view of an Interview for API responses (e.g. after create). Mirrors
 * the Prisma model's governance fields. The transcript itself is intentionally NOT
 * exposed here — it lives encrypted in S3 and is only ever surfaced as evidence quotes
 * inside an analysed scorecard draft.
 */
export interface SerializedInterview {
  id: string;
  orgId: string;
  applicationId: string;
  interviewerIds: string[];
  scheduledAt: string | null;
  durationMinutes: number | null;
  type: PrismaInterview["type"];
  status: PrismaInterview["status"];
  consentObtained: boolean;
  transcriptStatus: string | null;
  transcriptRetentionDeleteAt: string | null;
  transcriptDeletedAt: string | null;
  /** Whether a transcript object currently exists in the store (key present). */
  hasTranscript: boolean;
  createdAt: string;
}

export function serializeInterview(row: PrismaInterview): SerializedInterview {
  return {
    id: row.id,
    orgId: row.orgId,
    applicationId: row.applicationId,
    interviewerIds: row.interviewerIds,
    scheduledAt: isoOrNull(row.scheduledAt),
    durationMinutes: row.durationMinutes,
    type: row.type,
    status: row.status,
    consentObtained: row.consentObtained,
    transcriptStatus: row.transcriptStatus,
    transcriptRetentionDeleteAt: isoOrNull(row.transcriptRetentionDeleteAt),
    transcriptDeletedAt: isoOrNull(row.transcriptDeletedAt),
    hasTranscript: row.transcriptPath != null,
    createdAt: iso(row.createdAt),
  };
}

// ── Module 4 — Knowledge base + HR chatbot ────────────────────────────────────

/**
 * Prisma `PolicyDocument` row → the frozen `PolicyDocument` wire contract. `docType`
 * and `status` are free `String` columns in Prisma but constrained enums on the wire,
 * so we parse them through their schemas (an unexpected value throws rather than
 * leaking a non-contract string). `effectiveDate` is a `@db.Date` → IsoDate.
 */
export function serializePolicyDocument(row: PrismaPolicyDocument): TPolicyDocument {
  return PolicyDocument.parse({
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    docType: PolicyDocType.parse(row.docType),
    effectiveDate: isoDateOrNull(row.effectiveDate),
    version: row.version,
    ownerId: row.ownerId,
    status: PolicyStatus.parse(row.status),
    simhash: row.simhash,
    chunksIndexedAt: isoOrNull(row.chunksIndexedAt),
    createdAt: iso(row.createdAt),
  });
}

/** The persisted `citations` JSON column shape on an assistant ChatMessage. */
const StoredCitations = z.array(Citation).default([]);

/** The persisted `feedback` String column → the wire `ChatFeedback | null`. */
const StoredFeedback = z.enum(["positive", "negative"]).nullable();

/**
 * Prisma `ChatMessage` row → the frozen `ChatMessageRecord` wire contract. The
 * audit/analytics-only `topic` column is intentionally NOT part of the wire shape and
 * is dropped here. `citations` (assistant turns) is validated out of the Json column.
 */
export function serializeChatMessage(row: PrismaChatMessage): TChatMessageRecord {
  return ChatMessageRecord.parse({
    id: row.id,
    sessionId: row.sessionId,
    role: z.enum(["user", "assistant"]).parse(row.role),
    content: row.content,
    citations: StoredCitations.parse(row.citations ?? []),
    feedback: StoredFeedback.parse(row.feedback),
    createdAt: iso(row.createdAt),
  });
}

/** Prisma `HrTicket` row → the frozen `HrTicket` wire contract. */
export function serializeHrTicket(row: PrismaHrTicket): THrTicket {
  return HrTicket.parse({
    id: row.id,
    orgId: row.orgId,
    raisedById: row.raisedById,
    assigneeId: row.assigneeId,
    category: row.category,
    subject: row.subject,
    description: row.description,
    status: row.status,
    sessionId: row.sessionId,
    createdAt: iso(row.createdAt),
    resolvedAt: isoOrNull(row.resolvedAt),
  });
}

// ── Module 9 — Workflow Automation Engine ─────────────────────────────────────

/**
 * The `steps` JSON column shape on a WorkflowDefinition. Stored as the frozen
 * `WorkflowStep[]` contract; parsed back through it on read so a hand-edited or
 * malformed row can never leak a non-contract step (or crash the engine with a
 * shape it does not expect). A definition with zero valid steps is degenerate but
 * still parseable — the engine treats an empty step list as immediately terminal.
 */
const StoredSteps = z.array(WorkflowStep).default([]);

/**
 * Parse a definition's stored `steps` JSON into the typed `WorkflowStep[]` the
 * engine walks. Exposed separately from `serializeWorkflowDefinition` because the
 * engine needs the steps array (not the wire contract) on every advance, and the
 * worker tick reads it off raw owner-client rows.
 */
export function parseWorkflowSteps(steps: unknown): TWorkflowStep[] {
  return StoredSteps.parse(steps ?? []);
}

/** Prisma `WorkflowDefinition` row → the frozen `WorkflowDefinition` wire contract. */
export function serializeWorkflowDefinition(
  row: PrismaWorkflowDefinition,
): TWorkflowDefinition {
  return WorkflowDefinition.parse({
    id: row.id,
    orgId: row.orgId,
    key: row.key,
    name: row.name,
    description: row.description,
    // Free `String` columns narrowed through their contract enum on the way out, so
    // an unexpected stored value throws here rather than leaking a non-contract string.
    trigger: WorkflowTrigger.parse(row.trigger),
    eventType: row.eventType,
    schedule: row.schedule,
    steps: parseWorkflowSteps(row.steps),
    version: row.version,
    active: row.active,
    createdById: row.createdById,
    createdAt: iso(row.createdAt),
  });
}

/** Prisma `WorkflowInstance` row → the frozen `WorkflowInstance` wire contract. */
export function serializeWorkflowInstance(
  row: PrismaWorkflowInstance,
): TWorkflowInstance {
  return WorkflowInstance.parse({
    id: row.id,
    orgId: row.orgId,
    definitionId: row.definitionId,
    status: InstanceStatus.parse(row.status),
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    currentStepId: row.currentStepId,
    // The context column is free-form JSON; the contract requires a record. A null
    // (degenerate) value coerces to {} so a malformed row never throws on read.
    context: (row.context ?? {}) as Record<string, unknown>,
    startedAt: iso(row.startedAt),
    completedAt: isoOrNull(row.completedAt),
  });
}

/** Prisma `WorkflowTask` row → the frozen `WorkflowTask` wire contract. */
export function serializeWorkflowTask(row: PrismaWorkflowTask): TWorkflowTask {
  return WorkflowTask.parse({
    id: row.id,
    orgId: row.orgId,
    instanceId: row.instanceId,
    stepId: row.stepId,
    type: StepType.parse(row.type),
    name: row.name,
    // assigneeRole is a free String column → narrowed to the UserRole enum or null.
    assigneeRole:
      row.assigneeRole == null ? null : UserRole.parse(row.assigneeRole),
    assigneeId: row.assigneeId,
    status: TaskStatus.parse(row.status),
    outcome: row.outcome == null ? null : TaskOutcome.parse(row.outcome),
    dueAt: isoOrNull(row.dueAt),
    completedAt: isoOrNull(row.completedAt),
    completedById: row.completedById,
    note: row.note,
    createdAt: iso(row.createdAt),
  });
}
