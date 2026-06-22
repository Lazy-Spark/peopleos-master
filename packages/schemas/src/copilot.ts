import { z } from "zod";
import { CandidateProfile } from "./candidate.js";
import {
  CandidateId,
  CandidateSource,
  IsoDateTime,
  JobId,
  OrgId,
  Percent,
  RankingTier,
  RoleLevel,
  UnitScore,
  UserRole,
} from "./common.js";
import { OrgContext } from "./ai.js";
import { JDStructured } from "./job.js";
import { BiasCheck } from "./ranking.js";

/**
 * Module 2 — Recruiter Copilot contracts (2a JD Writer, 2b Outreach, 2c Chat
 * ReAct agent + internal tools, 2d LinkedIn sidebar). The AI-service-facing shapes
 * are mirrored as Pydantic in services/ai/app/schemas.py; camelCase end-to-end.
 */

// ═══ 2a — JOB DESCRIPTION WRITER ═════════════════════════════════════════════
/** An inclusive-language flag: a phrase to reconsider + a suggested alternative. */
export const InclusiveFlag = z.object({
  phrase: z.string(),
  category: z.enum(["GENDERED", "EXCLUSIONARY", "AGE", "JARGON", "ABLEIST", "OTHER"]),
  suggestion: z.string(),
});
export type InclusiveFlag = z.infer<typeof InclusiveFlag>;

export const InclusiveLanguageReport = z.object({
  flagged: z.array(InclusiveFlag).default([]),
  biasCheck: BiasCheck,
});
export type InclusiveLanguageReport = z.infer<typeof InclusiveLanguageReport>;

export const WriteJobDescriptionRequest = z.object({
  orgId: OrgId,
  roleTitle: z.string().min(1),
  seniority: RoleLevel.nullable().optional(),
  department: z.string().nullable().optional(),
  teamContext: z.string().nullable().optional(),
  hiringManagerNotes: z.string().nullable().optional(),
  orgContext: OrgContext.optional(),
  /** The org's prior JD texts, supplied by the API for tone-matched few-shot. */
  priorJdExamples: z.array(z.string()).default([]),
});
export type WriteJobDescriptionRequest = z.infer<typeof WriteJobDescriptionRequest>;

export const GeneratedJobDescription = z.object({
  title: z.string(),
  summary: z.string(),
  responsibilities: z.array(z.string()),
  requirements: z.array(z.string()),
  preferred: z.array(z.string()),
  benefits: z.array(z.string()),
  deiStatement: z.string(),
  /** Full assembled JD text — feedable directly to the JD parser (Module 1 step 1). */
  jdText: z.string(),
  inclusiveLanguage: InclusiveLanguageReport,
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type GeneratedJobDescription = z.infer<typeof GeneratedJobDescription>;

// ═══ 2b — CANDIDATE OUTREACH GENERATOR ═══════════════════════════════════════
export const OutreachTone = z.enum(["WARM", "FORMAL", "BRIEF"]);
export type OutreachTone = z.infer<typeof OutreachTone>;

export const OutreachVariant = z.object({
  tone: OutreachTone,
  subject: z.string(),
  body: z.string(),
});
export type OutreachVariant = z.infer<typeof OutreachVariant>;

export const GenerateOutreachRequest = z.object({
  orgId: OrgId,
  jobId: JobId,
  candidateId: CandidateId,
  /** Bias note: outreach IS personalised to the real person, so the profile is NOT
   *  masked here (unlike scoring). It references concrete resume details by design. */
  profile: CandidateProfile,
  jobTitle: z.string(),
  jobSummary: z.string().nullable().optional(),
  recruiterName: z.string(),
  orgContext: OrgContext.optional(),
  tones: z.array(OutreachTone).min(1).default(["WARM", "FORMAL", "BRIEF"]),
});
export type GenerateOutreachRequest = z.infer<typeof GenerateOutreachRequest>;

export const OutreachResult = z.object({
  variants: z.array(OutreachVariant),
  inMail: z.object({ subject: z.string().nullable(), body: z.string() }),
  /** Extra subject-line options for A/B testing (spec 2b). */
  subjectVariants: z.array(z.string()),
  biasCheck: BiasCheck,
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type OutreachResult = z.infer<typeof OutreachResult>;

// ═══ 2c — RECRUITER CHAT ASSISTANT (LangGraph ReAct) ═════════════════════════
export const ChatRole = z.enum(["user", "assistant"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatTurn = z.object({ role: ChatRole, content: z.string() });
export type ChatTurn = z.infer<typeof ChatTurn>;

/** A single tool invocation in the agent's trace (summary only — no raw data dumps). */
export const ChatToolInvocation = z.object({
  tool: z.string(),
  ok: z.boolean(),
  resultSummary: z.string().nullable(),
});
export type ChatToolInvocation = z.infer<typeof ChatToolInvocation>;

export const RecruiterChatRequest = z.object({
  orgId: OrgId,
  /** Reviewing user's role — fed to the agent for tone/permission framing. */
  userRole: UserRole.nullable().optional(),
  messages: z.array(ChatTurn).min(1),
  /** Active pipeline context (the job the recruiter is viewing), if any. */
  jobId: JobId.nullable().optional(),
});
export type RecruiterChatRequest = z.infer<typeof RecruiterChatRequest>;

export const RecruiterChatResponse = z.object({
  answer: z.string(),
  toolTrace: z.array(ChatToolInvocation).default([]),
  modelVersion: z.string(),
});
export type RecruiterChatResponse = z.infer<typeof RecruiterChatResponse>;

// ── Internal tool I/O (AI-service ReAct tools → API /internal/copilot/* ) ─────
// These endpoints are service-secret authenticated and tenant-scoped by the orgId
// in the body (which the API set from the end user's authenticated session).
export const ToolSearchCandidatesRequest = z.object({
  orgId: OrgId,
  query: z.string(),
  jobId: JobId.nullable().optional(),
  limit: z.number().int().min(1).max(25).default(10),
});
export type ToolSearchCandidatesRequest = z.infer<typeof ToolSearchCandidatesRequest>;

export const ToolCandidateHit = z.object({
  candidateId: CandidateId,
  name: z.string().nullable(),
  headline: z.string().nullable(),
  topSkills: z.array(z.string()).default([]),
});
export type ToolCandidateHit = z.infer<typeof ToolCandidateHit>;

export const ToolSearchCandidatesResponse = z.object({
  candidates: z.array(ToolCandidateHit),
});
export type ToolSearchCandidatesResponse = z.infer<typeof ToolSearchCandidatesResponse>;

export const ToolPipelineStatsRequest = z.object({ orgId: OrgId, jobId: JobId });
export type ToolPipelineStatsRequest = z.infer<typeof ToolPipelineStatsRequest>;

export const ToolPipelineStats = z.object({
  jobId: JobId,
  total: z.number().int().nonnegative(),
  byStage: z.record(z.number().int().nonnegative()),
  /** Stage→stage conversion rates in [0,1] (e.g. screened→interviewed). */
  conversionRates: z.record(UnitScore),
  /** Days the role has been open; null if unknown. */
  daysOpen: z.number().int().nullable(),
});
export type ToolPipelineStats = z.infer<typeof ToolPipelineStats>;

export const ToolCandidateRequest = z.object({ orgId: OrgId, candidateId: CandidateId });
export type ToolCandidateRequest = z.infer<typeof ToolCandidateRequest>;

export const ToolCandidateResponse = z.object({
  candidateId: CandidateId,
  name: z.string().nullable(),
  profile: CandidateProfile.nullable(),
  latestTier: RankingTier.nullable(),
});
export type ToolCandidateResponse = z.infer<typeof ToolCandidateResponse>;

// ═══ 2d — LINKEDIN SIDEBAR EXTENSION ═════════════════════════════════════════
export const LinkedInExperience = z.object({
  company: z.string().nullable(),
  title: z.string().nullable(),
  dateRange: z.string().nullable(),
  description: z.string().nullable(),
});
export type LinkedInExperience = z.infer<typeof LinkedInExperience>;

export const LinkedInEducation = z.object({
  school: z.string().nullable(),
  degree: z.string().nullable(),
  field: z.string().nullable(),
});
export type LinkedInEducation = z.infer<typeof LinkedInEducation>;

/** Raw data scraped from a LinkedIn profile page by the extension (with consent). */
export const LinkedInScrapedProfile = z.object({
  url: z.string().url(),
  name: z.string().nullable(),
  headline: z.string().nullable(),
  location: z.string().nullable(),
  about: z.string().nullable(),
  experience: z.array(LinkedInExperience).default([]),
  education: z.array(LinkedInEducation).default([]),
  skills: z.array(z.string()).default([]),
});
export type LinkedInScrapedProfile = z.infer<typeof LinkedInScrapedProfile>;

/** An open role to match a scraped profile against (supplied by the API from the DB). */
export const LinkedInMatchRole = z.object({
  jobId: JobId,
  title: z.string(),
  jdText: z.string().nullable(),
  jdStructured: JDStructured.nullable(),
});
export type LinkedInMatchRole = z.infer<typeof LinkedInMatchRole>;

/** Consent is mandatory (spec: "scrape LinkedIn profiles with consent"). */
export const AnalyzeLinkedInRequest = z.object({
  orgId: OrgId,
  profile: LinkedInScrapedProfile,
  consent: z.literal(true),
  /** The org's open roles to benchmark against (the AI service cannot query the DB). */
  roles: z.array(LinkedInMatchRole).default([]),
});
export type AnalyzeLinkedInRequest = z.infer<typeof AnalyzeLinkedInRequest>;

export const LinkedInRoleMatch = z.object({
  jobId: JobId,
  title: z.string(),
  matchScore: UnitScore,
  tier: RankingTier,
  skillMatchPct: Percent,
  topGaps: z.array(z.string()).default([]),
});
export type LinkedInRoleMatch = z.infer<typeof LinkedInRoleMatch>;

export const AnalyzeLinkedInResponse = z.object({
  summary: z.string(),
  candidateProfile: CandidateProfile,
  roleMatches: z.array(LinkedInRoleMatch),
  biasCheck: BiasCheck,
  modelVersion: z.string(),
});
export type AnalyzeLinkedInResponse = z.infer<typeof AnalyzeLinkedInResponse>;

/** "Add to Pool" — create a Candidate from a scraped profile (consent required). */
export const AddToPoolRequest = z.object({
  profile: LinkedInScrapedProfile,
  consent: z.literal(true),
  source: CandidateSource.default("LINKEDIN"),
});
export type AddToPoolRequest = z.infer<typeof AddToPoolRequest>;

export const AddToPoolResponse = z.object({
  candidateId: CandidateId,
  createdAt: IsoDateTime,
});
export type AddToPoolResponse = z.infer<typeof AddToPoolResponse>;
