import { z } from "zod";
import { OrgContext } from "./ai.js";
import { RiskTier } from "./analytics.js";
import { IsoDateTime, OrgId, RoleLevel, UnitScore, UserId } from "./common.js";
import { BiasCheck } from "./ranking.js";

/**
 * Module 8 — Internal Talent Marketplace (mobility / succession / gigs).
 *
 * Matching reuses the Module 6 skill graph (skill coverage → match + readiness + gap);
 * flight-risk reuses the Module 7 attrition TIER (governance: surfaced to ADMIN/HRBP only,
 * never the raw score). Internal applications are the source of the org's mobility metrics
 * (and Module 5 5b internalMobilityRate). camelCase end-to-end; the AI move-recommendation
 * surface is mirrored as Pydantic.
 */

// ═══ Enums ═══════════════════════════════════════════════════════════════════
export const InternalAppStatus = z.enum([
  "INTERESTED",
  "APPLIED",
  "SHORTLISTED",
  "WITHDRAWN",
  "REJECTED",
  "HIRED",
]);
export type InternalAppStatus = z.infer<typeof InternalAppStatus>;

/** How close an employee is to filling a role (derived from skill coverage). */
export const Readiness = z.enum(["READY_NOW", "READY_SOON", "STRETCH"]);
export type Readiness = z.infer<typeof Readiness>;

export const GigStatus = z.enum(["OPEN", "FILLED", "CLOSED"]);
export type GigStatus = z.infer<typeof GigStatus>;

export const GigInterestStatus = z.enum(["INTERESTED", "SELECTED", "DECLINED"]);
export type GigInterestStatus = z.infer<typeof GigInterestStatus>;

// ═══ Internal applications (the internal job board) ══════════════════════════
export const InternalApplication = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  employeeId: z.string().uuid(),
  jobOpeningId: z.string().uuid(),
  status: InternalAppStatus,
  matchScore: UnitScore.nullable(),
  note: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type InternalApplication = z.infer<typeof InternalApplication>;

/** An internal application joined with display fields (for lists / pipelines). */
export const InternalApplicationView = z.object({
  id: z.string().uuid(),
  jobOpeningId: z.string().uuid(),
  jobTitle: z.string(),
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable(),
  status: InternalAppStatus,
  matchScore: UnitScore.nullable(),
  note: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type InternalApplicationView = z.infer<typeof InternalApplicationView>;

export const CreateInternalApplicationRequest = z.object({
  jobOpeningId: z.string().uuid(),
  note: z.string().max(2000).optional(),
});
export type CreateInternalApplicationRequest = z.infer<typeof CreateInternalApplicationRequest>;

/** Recruiter/HRBP moves an internal application along the pipeline. */
export const UpdateInternalApplicationStatusRequest = z.object({ status: InternalAppStatus });
export type UpdateInternalApplicationStatusRequest = z.infer<
  typeof UpdateInternalApplicationStatusRequest
>;

// ═══ Matching — skill-graph driven ═══════════════════════════════════════════
/** "Recommended for you" — an internal role matched to an employee's skills (8a). */
export const RecommendedRole = z.object({
  jobOpeningId: z.string().uuid(),
  title: z.string(),
  department: z.string().nullable(),
  level: RoleLevel.nullable(),
  matchScore: UnitScore,
  readiness: Readiness,
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  gapSize: z.number().int().nonnegative(),
  /** True once this employee already has an internal application for the role. */
  alreadyApplied: z.boolean(),
});
export type RecommendedRole = z.infer<typeof RecommendedRole>;

export const RecommendedRoles = z.object({
  employeeId: z.string().uuid(),
  roles: z.array(RecommendedRole),
});
export type RecommendedRoles = z.infer<typeof RecommendedRoles>;

/** "Who internally could fill this role?" — an employee matched to an open role (8b). */
export const InternalCandidate = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable(),
  department: z.string().nullable(),
  level: RoleLevel.nullable(),
  matchScore: UnitScore,
  readiness: Readiness,
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  gapSize: z.number().int().nonnegative(),
  /** Attrition TIER only (Module 7 governance) — non-null ONLY for ADMIN/HRBP viewers. */
  flightRisk: RiskTier.nullable(),
});
export type InternalCandidate = z.infer<typeof InternalCandidate>;

export const RoleMatchResult = z.object({
  jobOpeningId: z.string().uuid(),
  title: z.string(),
  requiredSkills: z.array(z.string()),
  candidates: z.array(InternalCandidate),
});
export type RoleMatchResult = z.infer<typeof RoleMatchResult>;

// ═══ Succession planning (8d) ════════════════════════════════════════════════
export const SuccessionCandidate = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable(),
  level: RoleLevel.nullable(),
  readiness: Readiness,
  matchScore: UnitScore,
  gapSize: z.number().int().nonnegative(),
  flightRisk: RiskTier.nullable(),
});
export type SuccessionCandidate = z.infer<typeof SuccessionCandidate>;

export const SuccessionPlan = z.object({
  jobOpeningId: z.string().uuid().nullable(),
  roleTitle: z.string(),
  /** # internal candidates with any meaningful coverage (the bench). */
  benchStrength: z.number().int().nonnegative(),
  readyNow: z.number().int().nonnegative(),
  readySoon: z.number().int().nonnegative(),
  successors: z.array(SuccessionCandidate),
});
export type SuccessionPlan = z.infer<typeof SuccessionPlan>;

// ═══ Mobility analytics (feeds Module 5 5b internalMobilityRate) ═════════════
export const MobilityByDepartment = z.object({
  department: z.string(),
  internalHires: z.number().int().nonnegative(),
});
export type MobilityByDepartment = z.infer<typeof MobilityByDepartment>;

export const MobilityAnalytics = z.object({
  /** Internal HIRED moves / total internal applications (apply->hire conversion); null if none. */
  internalFillRate: UnitScore.nullable(),
  /** Internal moves / headcount; null if no headcount. */
  internalMobilityRate: UnitScore.nullable(),
  openInternalRoles: z.number().int().nonnegative(),
  totalInternalApplications: z.number().int().nonnegative(),
  hiredInternally: z.number().int().nonnegative(),
  byDepartment: z.array(MobilityByDepartment),
});
export type MobilityAnalytics = z.infer<typeof MobilityAnalytics>;

// ═══ Gig / stretch marketplace (8c) ══════════════════════════════════════════
export const Gig = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  title: z.string(),
  description: z.string(),
  requiredSkills: z.array(z.string()),
  durationWeeks: z.number().int().positive().nullable(),
  status: GigStatus,
  createdById: UserId.nullable(),
  createdAt: IsoDateTime,
});
export type Gig = z.infer<typeof Gig>;

export const CreateGigRequest = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  requiredSkills: z.array(z.string()).default([]),
  durationWeeks: z.number().int().positive().nullable().optional(),
});
export type CreateGigRequest = z.infer<typeof CreateGigRequest>;

/** A gig matched to an employee's skills (recommended gigs). */
export const GigMatch = z.object({
  gigId: z.string().uuid(),
  title: z.string(),
  matchScore: UnitScore,
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  durationWeeks: z.number().int().positive().nullable(),
});
export type GigMatch = z.infer<typeof GigMatch>;

export const RecommendedGigs = z.object({
  employeeId: z.string().uuid(),
  gigs: z.array(GigMatch),
});
export type RecommendedGigs = z.infer<typeof RecommendedGigs>;

// ═══ AI: move recommendation + development plan ══════════════════════════════
/** Non-PII context for the move explanation (NO name, NO demographics). */
export const MobilityEmployeeContext = z.object({
  roleTitle: z.string().nullable(),
  level: RoleLevel.nullable(),
  department: z.string().nullable(),
});
export type MobilityEmployeeContext = z.infer<typeof MobilityEmployeeContext>;

export const MobilityRecommendRequest = z.object({
  orgId: OrgId,
  targetRoleTitle: z.string(),
  requiredSkills: z.array(z.string()),
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  readiness: Readiness,
  employeeContext: MobilityEmployeeContext.optional(),
  orgContext: OrgContext.optional(),
});
export type MobilityRecommendRequest = z.infer<typeof MobilityRecommendRequest>;

export const DevelopmentStep = z.object({
  skill: z.string(),
  action: z.string(),
  suggestedResource: z.string().nullable(),
});
export type DevelopmentStep = z.infer<typeof DevelopmentStep>;

export const MobilityRecommendResponse = z.object({
  fitSummary: z.string(),
  developmentPlan: z.array(DevelopmentStep),
  confidence: z.enum(["low", "medium", "high"]),
  biasCheck: BiasCheck,
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type MobilityRecommendResponse = z.infer<typeof MobilityRecommendResponse>;
