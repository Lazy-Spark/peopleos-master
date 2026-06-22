import { z } from "zod";
import { OrgContext } from "./ai.js";
import { ChatTurn } from "./copilot.js";
import {
  Confidence,
  IsoDate,
  IsoDateTime,
  OrgId,
  UnitScore,
  UserId,
} from "./common.js";
import { BiasCheck } from "./ranking.js";

/**
 * Module 4 — Company knowledge base + Employee HR Chatbot (RAG) contracts.
 * AI-service-facing shapes are mirrored as Pydantic in services/ai/app/schemas.py;
 * camelCase end-to-end. The RAG answer is grounded ONLY in retrieved policy chunks.
 */

// ═══ Policy documents (Layer 2C) ═════════════════════════════════════════════
export const PolicyDocType = z.enum([
  "HANDBOOK",
  "BENEFITS",
  "PTO",
  "CONDUCT",
  "SECURITY",
  "COMPENSATION",
  "CAREER_LADDER",
  "OTHER",
]);
export type PolicyDocType = z.infer<typeof PolicyDocType>;

export const PolicyStatus = z.enum(["ACTIVE", "SUPERSEDED", "ARCHIVED"]);
export type PolicyStatus = z.infer<typeof PolicyStatus>;

export const PolicyDocument = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  title: z.string(),
  docType: PolicyDocType,
  effectiveDate: IsoDate.nullable(),
  version: z.number().int().positive(),
  ownerId: UserId.nullable(),
  status: PolicyStatus,
  simhash: z.string().nullable(),
  chunksIndexedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type PolicyDocument = z.infer<typeof PolicyDocument>;

/** API-facing: recruiter/HRBP uploads a policy (rawText for dev; fileUrl in prod). */
export const IngestPolicyRequest = z
  .object({
    title: z.string().min(1),
    docType: PolicyDocType,
    effectiveDate: IsoDate.nullable().optional(),
    ownerId: UserId.nullable().optional(),
    rawText: z.string().optional(),
    fileUrl: z.string().url().optional(),
  })
  .refine((v) => Boolean(v.rawText) !== Boolean(v.fileUrl), {
    message: "Provide exactly one of rawText or fileUrl",
  });
export type IngestPolicyRequest = z.infer<typeof IngestPolicyRequest>;

export const IngestPolicyResponse = z.object({
  document: PolicyDocument,
  chunkCount: z.number().int().nonnegative(),
  /** Set when this upload superseded a prior version (SimHash/version match). */
  supersededDocumentId: z.string().uuid().nullable(),
});
export type IngestPolicyResponse = z.infer<typeof IngestPolicyResponse>;

// ═══ AI service: chunk + embed ═══════════════════════════════════════════════
/** One semantic chunk produced by the document pipeline (Layer 2C step 3). */
export const DocumentChunkData = z.object({
  sectionPath: z.string(),
  text: z.string(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  pageNumber: z.number().int().nullable(),
  tokenCount: z.number().int().nonnegative(),
  embedding: z.array(z.number()),
});
export type DocumentChunkData = z.infer<typeof DocumentChunkData>;

export const PolicyIngestRequest = z.object({
  orgId: OrgId,
  docId: z.string().uuid(),
  docType: PolicyDocType,
  title: z.string(),
  rawText: z.string(),
});
export type PolicyIngestRequest = z.infer<typeof PolicyIngestRequest>;

export const PolicyIngestResponse = z.object({
  chunks: z.array(DocumentChunkData),
  /** SimHash fingerprint of the document for dedup/versioning. */
  simhash: z.string(),
  modelVersion: z.string(),
});
export type PolicyIngestResponse = z.infer<typeof PolicyIngestResponse>;

export const EmbedRequest = z.object({
  texts: z.array(z.string()).min(1).max(128),
});
export type EmbedRequest = z.infer<typeof EmbedRequest>;

export const EmbedResponse = z.object({
  embeddings: z.array(z.array(z.number())),
  model: z.string(),
  dim: z.number().int().positive(),
});
export type EmbedResponse = z.infer<typeof EmbedResponse>;

// ═══ RAG chat ════════════════════════════════════════════════════════════════
export const ChatIntent = z.enum(["POLICY_QUESTION", "ACTION_REQUEST", "ESCALATE"]);
export type ChatIntent = z.infer<typeof ChatIntent>;

/** A source citation surfaced with every grounded answer (spec step 4). */
export const Citation = z.object({
  docId: z.string().uuid(),
  docTitle: z.string(),
  sectionPath: z.string(),
  effectiveDate: IsoDate.nullable(),
});
export type Citation = z.infer<typeof Citation>;

/** A retrieved chunk passed to the AI for grounding (the API does retrieval). */
export const RetrievedChunk = z.object({
  docId: z.string().uuid(),
  docTitle: z.string(),
  sectionPath: z.string(),
  text: z.string(),
  effectiveDate: IsoDate.nullable(),
  score: UnitScore,
});
export type RetrievedChunk = z.infer<typeof RetrievedChunk>;

/** Employee context for personalised policy answers (spec step 3). Non-PII subset. */
export const EmployeeChatContext = z.object({
  department: z.string().nullable(),
  location: z.string().nullable(),
  hireDate: IsoDate.nullable(),
});
export type EmployeeChatContext = z.infer<typeof EmployeeChatContext>;

export const ChatAnswerRequest = z.object({
  orgId: OrgId,
  query: z.string().min(1),
  history: z.array(ChatTurn).default([]),
  candidateChunks: z.array(RetrievedChunk).default([]),
  employeeContext: EmployeeChatContext.optional(),
  orgContext: OrgContext.optional(),
});
export type ChatAnswerRequest = z.infer<typeof ChatAnswerRequest>;

export const ChatAnswerResponse = z.object({
  answer: z.string(),
  citations: z.array(Citation),
  intent: ChatIntent,
  /** True when the question should be handed to a human HRBP (spec step 5). */
  escalate: z.boolean(),
  escalationReason: z.string().nullable(),
  /** Detected sensitive topic that forced escalation, if any. */
  sensitiveTopic: z.string().nullable(),
  confidence: Confidence,
  /** Topic label for analytics (most-asked / unresolved clustering). */
  topic: z.string().nullable(),
  biasCheck: BiasCheck,
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type ChatAnswerResponse = z.infer<typeof ChatAnswerResponse>;

// ═══ API-facing chat ═════════════════════════════════════════════════════════
export const ChatChannel = z.enum(["WEB", "SLACK", "TEAMS", "MOBILE"]);
export type ChatChannel = z.infer<typeof ChatChannel>;

export const AskRequest = z.object({
  message: z.string().min(1),
  /** Continue an existing session, or omit to start a new one. */
  sessionId: z.string().uuid().nullable().optional(),
  channel: ChatChannel.default("WEB"),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const AskResponse = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().uuid(),
  answer: z.string(),
  citations: z.array(Citation),
  intent: ChatIntent,
  escalated: z.boolean(),
  /** Set when escalation created an HR ticket. */
  ticketId: z.string().uuid().nullable(),
  confidence: Confidence,
});
export type AskResponse = z.infer<typeof AskResponse>;

export const ChatFeedback = z.enum(["positive", "negative"]);
export type ChatFeedback = z.infer<typeof ChatFeedback>;

export const ChatFeedbackRequest = z.object({ feedback: ChatFeedback });
export type ChatFeedbackRequest = z.infer<typeof ChatFeedbackRequest>;

/** A persisted chat message as returned in session history. */
export const ChatMessageRecord = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  citations: z.array(Citation).default([]),
  feedback: ChatFeedback.nullable(),
  createdAt: IsoDateTime,
});
export type ChatMessageRecord = z.infer<typeof ChatMessageRecord>;

export const ChatSessionHistory = z.object({
  sessionId: z.string().uuid(),
  messages: z.array(ChatMessageRecord),
});
export type ChatSessionHistory = z.infer<typeof ChatSessionHistory>;

// ═══ HR tickets (escalation target — spec step 5 / Module 10) ════════════════
export const HrTicketCategory = z.enum(["POLICY", "SENSITIVE", "ACTION", "OTHER"]);
export type HrTicketCategory = z.infer<typeof HrTicketCategory>;

export const HrTicketStatus = z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]);
export type HrTicketStatus = z.infer<typeof HrTicketStatus>;

export const HrTicket = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  raisedById: UserId.nullable(),
  assigneeId: UserId.nullable(),
  category: HrTicketCategory,
  subject: z.string(),
  description: z.string(),
  status: HrTicketStatus,
  sessionId: z.string().uuid().nullable(),
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type HrTicket = z.infer<typeof HrTicket>;

export const CreateHrTicketRequest = z.object({
  category: HrTicketCategory,
  subject: z.string().min(1),
  description: z.string().min(1),
  sessionId: z.string().uuid().nullable().optional(),
});
export type CreateHrTicketRequest = z.infer<typeof CreateHrTicketRequest>;
