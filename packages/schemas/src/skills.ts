import { z } from "zod";
import { OrgContext } from "./ai.js";
import {
  Confidence,
  IsoDateTime,
  OrgId,
  ProficiencyLevel,
  SkillCategory,
  SkillSource,
  UnitScore,
  UserId,
} from "./common.js";
import { BiasCheck } from "./ranking.js";

/**
 * Module 6 — Employee Skill Graph contracts. The graph is modelled relationally in
 * Postgres (Neo4j is the documented prod adapter); graph queries are computed in-API.
 * AI-facing shapes (growth path, build-vs-buy) are mirrored as Pydantic. camelCase end-to-end.
 */

// ═══ Confidence by source (spec Layer 3A skill confidence scoring) ═══════════
export const SKILL_SOURCE_CONFIDENCE: Record<SkillSource, number> = {
  SELF_REPORTED: 0.5,
  MANAGER_VERIFIED: 0.8,
  ASSESSMENT_VERIFIED: 0.9,
  INFERRED_RESUME: 0.6,
  INFERRED_PROJECT: 0.7,
};

/** The canonical confidence score for a skill assertion's provenance. */
export function confidenceForSource(source: SkillSource): number {
  return SKILL_SOURCE_CONFIDENCE[source];
}

// ═══ Entities ════════════════════════════════════════════════════════════════
export const Skill = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  canonicalName: z.string(),
  aliases: z.array(z.string()).default([]),
  category: SkillCategory,
  escoUri: z.string().nullable(),
  parentSkillId: z.string().uuid().nullable(),
});
export type Skill = z.infer<typeof Skill>;

export const SkillRecord = z.object({
  id: z.string().uuid(),
  orgId: OrgId,
  employeeId: z.string().uuid(),
  skillId: z.string().uuid(),
  proficiency: ProficiencyLevel,
  confidenceScore: UnitScore,
  source: SkillSource,
  verifiedById: UserId.nullable(),
  verifiedAt: IsoDateTime.nullable(),
});
export type SkillRecord = z.infer<typeof SkillRecord>;

/** A skill record joined with its skill's display fields (for profiles / who-has). */
export const SkillRecordView = z.object({
  id: z.string().uuid(),
  skillId: z.string().uuid(),
  skillName: z.string(),
  category: SkillCategory,
  proficiency: ProficiencyLevel,
  confidenceScore: UnitScore,
  source: SkillSource,
  verifiedAt: IsoDateTime.nullable(),
});
export type SkillRecordView = z.infer<typeof SkillRecordView>;

export const EmployeeSkillProfile = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable(),
  skills: z.array(SkillRecordView),
});
export type EmployeeSkillProfile = z.infer<typeof EmployeeSkillProfile>;

// ═══ Requests ════════════════════════════════════════════════════════════════
export const CreateSkillRequest = z.object({
  canonicalName: z.string().min(1),
  category: SkillCategory,
  aliases: z.array(z.string()).default([]),
  parentSkillId: z.string().uuid().nullable().optional(),
});
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>;

/** Employee self-reports an existing catalog skill (source SELF_REPORTED, confidence 0.5). */
export const AddEmployeeSkillRequest = z.object({
  skillId: z.string().uuid(),
  proficiency: ProficiencyLevel,
});
export type AddEmployeeSkillRequest = z.infer<typeof AddEmployeeSkillRequest>;

/** Manager confirms a skill (→ MANAGER_VERIFIED, confidence 0.8); may adjust proficiency. */
export const VerifySkillRequest = z.object({
  proficiency: ProficiencyLevel.optional(),
});
export type VerifySkillRequest = z.infer<typeof VerifySkillRequest>;

// ═══ Graph query results ═════════════════════════════════════════════════════
export const SkillGapReport = z.object({
  employeeId: z.string().uuid(),
  targetRoleId: z.string().uuid(),
  targetRoleTitle: z.string(),
  requiredSkills: z.array(z.string()),
  matched: z.array(z.string()),
  missing: z.array(z.string()),
  gapSize: z.number().int().nonnegative(),
  coverage: UnitScore,
});
export type SkillGapReport = z.infer<typeof SkillGapReport>;

export const SkillHolder = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable(),
  proficiency: ProficiencyLevel,
  confidenceScore: UnitScore,
});
export type SkillHolder = z.infer<typeof SkillHolder>;

export const WhoHasSkillResult = z.object({
  skillId: z.string().uuid(),
  skillName: z.string(),
  holders: z.array(SkillHolder),
});
export type WhoHasSkillResult = z.infer<typeof WhoHasSkillResult>;

export const TeamMemberSkills = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable(),
  skills: z.array(
    z.object({ skillName: z.string(), proficiency: ProficiencyLevel, confidenceScore: UnitScore }),
  ),
});
export type TeamMemberSkills = z.infer<typeof TeamMemberSkills>;

export const TeamBusFactor = z.object({
  skillId: z.string().uuid(),
  skillName: z.string(),
  holders: z.number().int().nonnegative(),
});
export type TeamBusFactor = z.infer<typeof TeamBusFactor>;

export const BenchStrength = z.object({
  skillId: z.string().uuid(),
  skillName: z.string(),
  count: z.number().int().nonnegative(),
});
export type BenchStrength = z.infer<typeof BenchStrength>;

export const TeamSkillMap = z.object({
  managerId: z.string().uuid(),
  members: z.array(TeamMemberSkills),
  /** Skills held by exactly one team member (bus-factor risk, spec 6b). */
  busFactor: z.array(TeamBusFactor),
  benchStrength: z.array(BenchStrength),
});
export type TeamSkillMap = z.infer<typeof TeamSkillMap>;

export const SkillInventoryItem = z.object({
  skillId: z.string().uuid(),
  skillName: z.string(),
  category: SkillCategory,
  /** # employees holding the skill. */
  supply: z.number().int().nonnegative(),
  /** # open roles requiring the skill. */
  demand: z.number().int().nonnegative(),
  gap: z.number().int(),
});
export type SkillInventoryItem = z.infer<typeof SkillInventoryItem>;

export const SkillInventory = z.object({
  items: z.array(SkillInventoryItem),
  /** % of employees meeting/exceeding their role's skill bar; null if not derivable. */
  talentDensityIndex: UnitScore.nullable(),
});
export type SkillInventory = z.infer<typeof SkillInventory>;

// ═══ AI: growth path (6a) ════════════════════════════════════════════════════
export const EmployeeSkillBrief = z.object({
  name: z.string(),
  proficiency: ProficiencyLevel,
});
export type EmployeeSkillBrief = z.infer<typeof EmployeeSkillBrief>;

export const GrowthPathRequest = z.object({
  orgId: OrgId,
  employeeSkills: z.array(EmployeeSkillBrief),
  targetRoleTitle: z.string(),
  targetRequiredSkills: z.array(z.string()),
  skillCatalog: z.array(z.string()).default([]),
  orgContext: OrgContext.optional(),
});
export type GrowthPathRequest = z.infer<typeof GrowthPathRequest>;

export const RecommendedSkill = z.object({
  skill: z.string(),
  why: z.string(),
  suggestedTraining: z.string().nullable(),
});
export type RecommendedSkill = z.infer<typeof RecommendedSkill>;

export const GrowthPathResponse = z.object({
  summary: z.string(),
  /** How many distinct skills the employee is away from the target role. */
  stepsAway: z.number().int().nonnegative(),
  recommendedSkills: z.array(RecommendedSkill),
  confidence: Confidence,
  biasCheck: BiasCheck,
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type GrowthPathResponse = z.infer<typeof GrowthPathResponse>;

// ═══ AI: build-vs-buy (6c) ═══════════════════════════════════════════════════
export const BuildVsBuyRecommendation = z.enum(["BUILD", "BUY", "HYBRID"]);
export type BuildVsBuyRecommendation = z.infer<typeof BuildVsBuyRecommendation>;

export const BuildVsBuyRequest = z.object({
  orgId: OrgId,
  skill: z.string(),
  currentSupply: z.number().int().nonnegative(),
  demand: z.number().int().nonnegative(),
  /** # current employees who are 1-2 skills away (trainable into the gap). */
  trainableInternally: z.number().int().nonnegative(),
  orgContext: OrgContext.optional(),
});
export type BuildVsBuyRequest = z.infer<typeof BuildVsBuyRequest>;

export const BuildVsBuyResponse = z.object({
  recommendation: BuildVsBuyRecommendation,
  rationale: z.string(),
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type BuildVsBuyResponse = z.infer<typeof BuildVsBuyResponse>;
