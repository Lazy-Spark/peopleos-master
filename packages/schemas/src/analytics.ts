import { z } from "zod";
import { OrgContext } from "./ai.js";
import {
  ApplicationStage,
  CandidateSource,
  IsoDateTime,
  OrgId,
  RoleLevel,
  UnitScore,
} from "./common.js";
import { FlagSeverity } from "./interview.js";

/**
 * Module 5 — Workforce Analytics Dashboard contracts. The API computes DashboardMetrics
 * from Postgres (prod: Snowflake + DBT); the AI service narrates / answers questions
 * grounded ONLY in the supplied metrics. camelCase end-to-end; AI-facing shapes mirrored
 * as Pydantic in services/ai/app/schemas.py.
 */

/** Attrition risk tier (spec Module 7 AttritionScore; surfaced in 5c). */
export const RiskTier = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
export type RiskTier = z.infer<typeof RiskTier>;

// ═══ 5a — Recruiting funnel ══════════════════════════════════════════════════
export const FunnelStage = z.object({ stage: ApplicationStage, count: z.number().int().nonnegative() });
export type FunnelStage = z.infer<typeof FunnelStage>;

export const StageConversion = z.object({
  from: ApplicationStage,
  to: ApplicationStage,
  rate: UnitScore,
});
export type StageConversion = z.infer<typeof StageConversion>;

export const SourceOfHire = z.object({ source: CandidateSource, count: z.number().int().nonnegative() });
export type SourceOfHire = z.infer<typeof SourceOfHire>;

export const SlaBreach = z.object({
  jobId: z.string().uuid(),
  title: z.string(),
  daysOpen: z.number().int().nonnegative(),
});
export type SlaBreach = z.infer<typeof SlaBreach>;

export const RecruitingFunnel = z.object({
  byStage: z.array(FunnelStage),
  conversionRates: z.array(StageConversion),
  totalApplications: z.number().int().nonnegative(),
  openRoles: z.number().int().nonnegative(),
  /** Avg days from job open → close for filled roles; null if none filled. */
  timeToFillDays: z.number().nullable(),
  /** Avg days from application → HIRED; null if no hires. */
  timeToHireDays: z.number().nullable(),
  offerAcceptanceRate: UnitScore.nullable(),
  sourceOfHire: z.array(SourceOfHire),
  /** Roles open longer than the SLA threshold (flagged red). */
  slaBreaches: z.array(SlaBreach),
});
export type RecruitingFunnel = z.infer<typeof RecruitingFunnel>;

// ═══ 5b — Workforce composition ══════════════════════════════════════════════
export const HeadcountBucket = z.object({ key: z.string(), count: z.number().int().nonnegative() });
export type HeadcountBucket = z.infer<typeof HeadcountBucket>;

export const SpanFlag = z.enum(["WIDE", "NARROW", "OK"]);
export type SpanFlag = z.infer<typeof SpanFlag>;

export const SpanOfControl = z.object({
  managerId: z.string().uuid(),
  managerName: z.string().nullable(),
  directReports: z.number().int().nonnegative(),
  /** WIDE (>8 reports) / NARROW (<3) are flagged for review (spec 5b). */
  flag: SpanFlag,
});
export type SpanOfControl = z.infer<typeof SpanOfControl>;

export const PromotionByLevel = z.object({
  level: RoleLevel,
  promoted: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  rate: UnitScore,
});
export type PromotionByLevel = z.infer<typeof PromotionByLevel>;

export const WorkforceComposition = z.object({
  totalHeadcount: z.number().int().nonnegative(),
  byDepartment: z.array(HeadcountBucket),
  byLocation: z.array(HeadcountBucket),
  byLevel: z.array(HeadcountBucket),
  byEmploymentType: z.array(HeadcountBucket),
  spanOfControl: z.array(SpanOfControl),
  promotionRateByLevel: z.array(PromotionByLevel),
  /** % of recent new hires past 90 days with a good perf rating; null if none. */
  newHireSuccessRate: UnitScore.nullable(),
  /** % of filled roles filled internally; null if not derivable. */
  internalMobilityRate: UnitScore.nullable(),
});
export type WorkforceComposition = z.infer<typeof WorkforceComposition>;

// ═══ 5c — Engagement & retention (lights up with Module 7 + surveys) ═════════
export const AttritionTierCount = z.object({ tier: RiskTier, count: z.number().int().nonnegative() });
export type AttritionTierCount = z.infer<typeof AttritionTierCount>;

export const AttritionHeatCell = z.object({
  dimension: z.enum(["TEAM", "DEPARTMENT", "LEVEL"]),
  group: z.string(),
  tier: RiskTier,
  count: z.number().int().nonnegative(),
});
export type AttritionHeatCell = z.infer<typeof AttritionHeatCell>;

export const EnpsPoint = z.object({ period: z.string(), score: z.number() });
export type EnpsPoint = z.infer<typeof EnpsPoint>;

export const EngagementRetention = z.object({
  /** False until Module 7 (attrition) / survey integration provide data. */
  available: z.boolean(),
  pendingReason: z.string().nullable(),
  attritionByTier: z.array(AttritionTierCount),
  attritionHeatmap: z.array(AttritionHeatCell),
  regrettableCount: z.number().int().nonnegative(),
  enpsTrend: z.array(EnpsPoint),
});
export type EngagementRetention = z.infer<typeof EngagementRetention>;

// ═══ 5d — Skills & talent density (lights up with Module 6 skill graph) ═══════
export const SkillGap = z.object({
  skill: z.string(),
  required: z.number().int().nonnegative(),
  supply: z.number().int().nonnegative(),
  gap: z.number().int(),
});
export type SkillGap = z.infer<typeof SkillGap>;

export const BusFactorRisk = z.object({ skill: z.string(), holders: z.number().int().nonnegative() });
export type BusFactorRisk = z.infer<typeof BusFactorRisk>;

export const SkillsTalent = z.object({
  available: z.boolean(),
  pendingReason: z.string().nullable(),
  skillGaps: z.array(SkillGap),
  busFactorRisks: z.array(BusFactorRisk),
  talentDensityIndex: UnitScore.nullable(),
});
export type SkillsTalent = z.infer<typeof SkillsTalent>;

// ═══ Dashboard ═══════════════════════════════════════════════════════════════
export const DashboardMetrics = z.object({
  orgId: OrgId,
  generatedAt: IsoDateTime,
  recruiting: RecruitingFunnel,
  workforce: WorkforceComposition,
  engagement: EngagementRetention,
  skills: SkillsTalent,
});
export type DashboardMetrics = z.infer<typeof DashboardMetrics>;

// ═══ 5e — AI narrative + anomaly + "Ask your data" ═══════════════════════════
export const NarrativeMetric = z.object({
  label: z.string(),
  value: z.string(),
  note: z.string().nullable(),
});
export type NarrativeMetric = z.infer<typeof NarrativeMetric>;

export const Anomaly = z.object({
  metric: z.string(),
  detail: z.string(),
  severity: FlagSeverity,
});
export type Anomaly = z.infer<typeof Anomaly>;

export const AnalyticsNarrativeRequest = z.object({
  orgId: OrgId,
  metrics: DashboardMetrics,
  orgContext: OrgContext.optional(),
});
export type AnalyticsNarrativeRequest = z.infer<typeof AnalyticsNarrativeRequest>;

export const AnalyticsNarrativeResponse = z.object({
  headline: z.string(),
  /** 3-paragraph executive narrative ("the 3 most important people metrics"). */
  narrative: z.string(),
  keyMetrics: z.array(NarrativeMetric),
  anomalies: z.array(Anomaly),
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type AnalyticsNarrativeResponse = z.infer<typeof AnalyticsNarrativeResponse>;

export const ChartSpec = z.object({
  type: z.enum(["BAR", "LINE", "PIE"]),
  title: z.string(),
  series: z.array(z.object({ label: z.string(), value: z.number() })),
});
export type ChartSpec = z.infer<typeof ChartSpec>;

/** AI service contract: answer a NL question grounded ONLY in the supplied metrics. */
export const AskDataRequest = z.object({
  orgId: OrgId,
  question: z.string().min(1),
  metrics: DashboardMetrics,
  orgContext: OrgContext.optional(),
});
export type AskDataRequest = z.infer<typeof AskDataRequest>;

export const AskDataResponse = z.object({
  answer: z.string(),
  /** Which metric keys the answer drew on (transparency; no free SQL is generated). */
  usedMetrics: z.array(z.string()),
  chart: ChartSpec.nullable(),
  confidence: z.enum(["low", "medium", "high"]),
  modelVersion: z.string(),
});
export type AskDataResponse = z.infer<typeof AskDataResponse>;

/** API-facing: the client asks a question; the API supplies the metrics snapshot. */
export const AskDataApiRequest = z.object({ question: z.string().min(1) });
export type AskDataApiRequest = z.infer<typeof AskDataApiRequest>;
