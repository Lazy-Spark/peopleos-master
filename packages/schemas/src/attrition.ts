import { z } from "zod";
import { OrgContext } from "./ai.js";
import { AttritionHeatCell, AttritionTierCount, RiskTier } from "./analytics.js";
import { DisparityReport } from "./audit.js";
import { IsoDateTime, OrgId, RoleLevel, UnitScore } from "./common.js";
import { BiasCheck } from "./ranking.js";

/**
 * Module 7 — Attrition Prediction Engine contracts.
 *
 * The ML model + SHAP live in the AI service (a transparent cold-start scorer for dev;
 * XGBoost/LightGBM/SHAP/MLflow are the documented prod adapter). The score is ADVISORY
 * ONLY. Governance is in the contracts/API: managers see tier + recommendation (never
 * the raw score/features), it is NEVER shown to the employee, and employees may opt out.
 * camelCase end-to-end; AI-facing shapes mirrored as Pydantic.
 */

// ═══ Features (the AVAILABLE subset; engagement/comp/email features need integrations
//      that are not built and are simply omitted — the model treats them as neutral) ══
export const AttritionFeatures = z.object({
  tenureDays: z.number().nonnegative(),
  timeInRoleDays: z.number().nonnegative().nullable(),
  daysSinceLastPromotion: z.number().nonnegative().nullable(),
  daysSinceLastReview: z.number().nonnegative().nullable(),
  /** Latest performance rating (1-5); null if none. */
  perfRating: z.number().nullable(),
  /** Share of the employee's team terminated in the last 90 days, [0,1]. */
  teamAttritionRate90d: UnitScore,
  managerChanged90d: z.boolean(),
  skillAdditions90d: z.number().int().nonnegative(),
});
export type AttritionFeatures = z.infer<typeof AttritionFeatures>;

export const DriverDirection = z.enum(["INCREASES", "DECREASES"]);
export type DriverDirection = z.infer<typeof DriverDirection>;

/** One SHAP-style feature contribution to the risk score. */
export const DriverContribution = z.object({
  feature: z.string(),
  label: z.string(),
  contribution: z.number(),
  direction: DriverDirection,
});
export type DriverContribution = z.infer<typeof DriverContribution>;

// ═══ AI service: scorer ══════════════════════════════════════════════════════
export const EmployeeFeatures = z.object({
  employeeId: z.string().uuid(),
  features: AttritionFeatures,
});
export type EmployeeFeatures = z.infer<typeof EmployeeFeatures>;

export const ScoreAttritionRequest = z.object({
  orgId: OrgId,
  employees: z.array(EmployeeFeatures).min(1).max(2000),
});
export type ScoreAttritionRequest = z.infer<typeof ScoreAttritionRequest>;

export const ScoredEmployee = z.object({
  employeeId: z.string().uuid(),
  riskScore: UnitScore,
  riskTier: RiskTier,
  topDrivers: z.array(DriverContribution),
  shapValues: z.record(z.number()),
});
export type ScoredEmployee = z.infer<typeof ScoredEmployee>;

export const ScoreAttritionResponse = z.object({
  scores: z.array(ScoredEmployee),
  modelVersion: z.string(),
});
export type ScoreAttritionResponse = z.infer<typeof ScoreAttritionResponse>;

// ═══ AI service: LLM explanation (grounded ONLY in topDrivers) ═══════════════
/** Non-PII employee context for the explanation (NO name, NO demographics). */
export const AttritionEmployeeContext = z.object({
  tenureDays: z.number().nonnegative(),
  roleTitle: z.string().nullable(),
  department: z.string().nullable(),
  level: RoleLevel.nullable(),
});
export type AttritionEmployeeContext = z.infer<typeof AttritionEmployeeContext>;

export const ExplainAttritionRequest = z.object({
  orgId: OrgId,
  riskTier: RiskTier,
  topDrivers: z.array(DriverContribution),
  employeeContext: AttritionEmployeeContext,
  orgContext: OrgContext.optional(),
});
export type ExplainAttritionRequest = z.infer<typeof ExplainAttritionRequest>;

export const ExplainAttritionResponse = z.object({
  narrative: z.string(),
  recommendedActions: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
  biasCheck: BiasCheck,
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type ExplainAttritionResponse = z.infer<typeof ExplainAttritionResponse>;

// ═══ API-facing views (role-gated; spec: managers never see raw score/features) ══
/** Full view — ADMIN / HRBP only (audit/people-ops). Includes raw score + drivers. */
export const AttritionEmployeeView = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable(),
  riskScore: UnitScore,
  riskTier: RiskTier,
  topDrivers: z.array(DriverContribution),
  shapValues: z.record(z.number()),
  narrative: z.string().nullable(),
  recommendedActions: z.array(z.string()),
  scoredAt: IsoDateTime,
});
export type AttritionEmployeeView = z.infer<typeof AttritionEmployeeView>;

/** Manager view — TIER + RECOMMENDATION ONLY. No raw score, no SHAP, no feature values. */
export const ManagerAttritionView = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable(),
  riskTier: RiskTier,
  recommendedActions: z.array(z.string()),
  scoredAt: IsoDateTime,
});
export type ManagerAttritionView = z.infer<typeof ManagerAttritionView>;

export const AttritionSummary = z.object({
  byTier: z.array(AttritionTierCount),
  heatmap: z.array(AttritionHeatCell),
  /** Loss of a strong performer (high perf + high risk). */
  regrettableCount: z.number().int().nonnegative(),
  scoredCount: z.number().int().nonnegative(),
  optedOutCount: z.number().int().nonnegative(),
  generatedAt: IsoDateTime,
});
export type AttritionSummary = z.infer<typeof AttritionSummary>;

export const RunScoringResponse = z.object({
  scoredCount: z.number().int().nonnegative(),
  skippedOptedOut: z.number().int().nonnegative(),
  byTier: z.array(AttritionTierCount),
  modelVersion: z.string(),
  scoredAt: IsoDateTime,
});
export type RunScoringResponse = z.infer<typeof RunScoringResponse>;

export const AttritionOptOutRequest = z.object({ optOut: z.boolean() });
export type AttritionOptOutRequest = z.infer<typeof AttritionOptOutRequest>;

// ═══ Bias audit (monthly disparity over tiers — reuses the Module 1 engine) ══
export const AttritionBiasAuditRequest = z.object({
  /** employeeId → demographic group label (provided by the org; never stored). */
  demographics: z
    .array(z.object({ employeeId: z.string().uuid(), group: z.string().min(1) }))
    .min(1),
  /** Which tiers count as a "flagged" outcome (default CRITICAL + HIGH). */
  selectionTiers: z.array(RiskTier).optional(),
});
export type AttritionBiasAuditRequest = z.infer<typeof AttritionBiasAuditRequest>;

export const AttritionBiasAuditResponse = z.object({
  report: DisparityReport,
  /** Employees in the mapping with no current score (excluded from the report). */
  unmatched: z.array(z.string().uuid()),
});
export type AttritionBiasAuditResponse = z.infer<typeof AttritionBiasAuditResponse>;
