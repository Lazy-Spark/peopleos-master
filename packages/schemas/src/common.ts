import { z } from "zod";

/**
 * Common primitives, enums, and branded IDs shared across PeopleOS.
 *
 * Convention: the contract is camelCase end-to-end. TypeScript/Zod use camelCase
 * keys; the AI service (Pydantic) emits the same camelCase keys; Prisma maps these
 * field names to snake_case columns via @map. Keep this convention — the boundary
 * verification step asserts it.
 */

// ── Branded IDs ──────────────────────────────────────────────────────────────
// UUIDs are validated AND branded so an OrgId can't be passed where a JobId is
// expected. `.brand` is compile-time only; runtime value is a plain string.
export const OrgId = z.string().uuid().brand<"OrgId">();
export const UserId = z.string().uuid().brand<"UserId">();
export const JobId = z.string().uuid().brand<"JobId">();
export const CandidateId = z.string().uuid().brand<"CandidateId">();
export const ApplicationId = z.string().uuid().brand<"ApplicationId">();
export const InterviewId = z.string().uuid().brand<"InterviewId">();
export const ScorecardId = z.string().uuid().brand<"ScorecardId">();
export const OfferId = z.string().uuid().brand<"OfferId">();

export type OrgId = z.infer<typeof OrgId>;
export type UserId = z.infer<typeof UserId>;
export type JobId = z.infer<typeof JobId>;
export type CandidateId = z.infer<typeof CandidateId>;
export type ApplicationId = z.infer<typeof ApplicationId>;
export type InterviewId = z.infer<typeof InterviewId>;
export type ScorecardId = z.infer<typeof ScorecardId>;
export type OfferId = z.infer<typeof OfferId>;

// ── Scalars ──────────────────────────────────────────────────────────────────
/** ISO-8601 timestamp string (the wire format for all datetimes). */
export const IsoDateTime = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** ISO-8601 date (YYYY-MM-DD), used for hire dates, employment periods, etc. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export type IsoDate = z.infer<typeof IsoDate>;

/** A normalized [0,1] score. */
export const UnitScore = z.number().min(0).max(1);
export type UnitScore = z.infer<typeof UnitScore>;

/** A percentage in [0,100]. */
export const Percent = z.number().min(0).max(100);
export type Percent = z.infer<typeof Percent>;

// ── Enums ────────────────────────────────────────────────────────────────────
export const UserRole = z.enum(["ADMIN", "RECRUITER", "HRBP", "MANAGER", "EMPLOYEE"]);
export type UserRole = z.infer<typeof UserRole>;

export const PlanTier = z.enum(["STARTER", "GROWTH", "ENTERPRISE", "PLATFORM"]);
export type PlanTier = z.infer<typeof PlanTier>;

export const JobStatus = z.enum(["DRAFT", "OPEN", "PAUSED", "CLOSED"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobType = z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "TEMP"]);
export type JobType = z.infer<typeof JobType>;

/** Career levels — ordered. HR-BERT in later phases learns these distinctions. */
export const RoleLevel = z.enum([
  "INTERN",
  "JUNIOR",
  "MID",
  "SENIOR",
  "STAFF",
  "PRINCIPAL",
  "MANAGER",
  "DIRECTOR",
  "VP",
  "EXEC",
]);
export type RoleLevel = z.infer<typeof RoleLevel>;

export const ApplicationStage = z.enum([
  "APPLIED",
  "SCREENING",
  "INTERVIEW",
  "OFFER",
  "HIRED",
  "REJECTED",
  "WITHDRAWN",
]);
export type ApplicationStage = z.infer<typeof ApplicationStage>;

export const ApplicationStatus = z.enum(["ACTIVE", "ON_HOLD", "ARCHIVED"]);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;

export const CandidateSource = z.enum([
  "DIRECT",
  "REFERRAL",
  "LINKEDIN",
  "INDEED",
  "GLASSDOOR",
  "JOB_BOARD",
  "AGENCY",
  "EMAIL_APPLY",
  "IMPORT",
]);
export type CandidateSource = z.infer<typeof CandidateSource>;

/** Skill taxonomy buckets (resume pipeline step 2 / skill graph categories). */
export const SkillCategory = z.enum(["TECHNICAL", "DOMAIN", "SOFT", "LANGUAGE", "CERTIFICATION"]);
export type SkillCategory = z.infer<typeof SkillCategory>;

/** Proficiency ladder (spec Module 6). */
export const ProficiencyLevel = z.enum(["AWARE", "PRACTITIONER", "ADVANCED", "EXPERT"]);
export type ProficiencyLevel = z.infer<typeof ProficiencyLevel>;

/**
 * Where a skill assertion came from. Drives the confidence score
 * (spec Layer 3A: self=0.5, manager=0.8, assessment=0.9, resume=0.6, project=0.7).
 */
export const SkillSource = z.enum([
  "SELF_REPORTED",
  "MANAGER_VERIFIED",
  "ASSESSMENT_VERIFIED",
  "INFERRED_RESUME",
  "INFERRED_PROJECT",
]);
export type SkillSource = z.infer<typeof SkillSource>;

/** Candidate ranking tier (spec Module 1 output). */
export const RankingTier = z.enum(["A", "B", "C", "D"]);
export type RankingTier = z.infer<typeof RankingTier>;

/** Model self-reported confidence; low → flag for human review (prompt standard #1). */
export const Confidence = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof Confidence>;

// ── Pagination ─────────────────────────────────────────────────────────────
export const PageQuery = z.object({
  cursor: z.string().optional(),
  // `coerce` because pagination is read from the query string, where every value
  // arrives as a string ("20"); plain z.number() would reject it (HTTP 400).
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function pageResponse<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

// ── Errors (uniform API error envelope) ─────────────────────────────────────
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
