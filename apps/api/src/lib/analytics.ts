import type {
  ApplicationStage as PrismaApplicationStage,
  CandidateSource as PrismaCandidateSource,
  RoleLevel as PrismaRoleLevel,
} from "@prisma/client";
import {
  DashboardMetrics,
  RecruitingFunnel,
  WorkforceComposition,
  EngagementRetention,
  SkillsTalent,
  type DashboardMetrics as TDashboardMetrics,
  type RecruitingFunnel as TRecruitingFunnel,
  type WorkforceComposition as TWorkforceComposition,
  type AttritionHeatCell as TAttritionHeatCell,
  type RiskTier as TRiskTier,
  type SpanFlag as TSpanFlag,
  type StageConversion as TStageConversion,
} from "@peopleos/schemas";
import type { TxClient } from "../db.js";
import { skillInventory } from "./skillGraph.js";
import { countByTier, isRegrettable, loadLatestScores } from "./attritionScores.js";

/**
 * Module 5 — Workforce Analytics metric aggregation. `computeDashboard` builds a
 * full `DashboardMetrics` snapshot for one org, entirely from Postgres via Prisma.
 *
 * PROD NOTE (spec 5 technical notes): in production these metrics are materialised
 * by scheduled DBT models in Snowflake (near-real-time for recruiting via webhook,
 * daily for HRMS-sourced metrics). This brute-force Prisma aggregation is the
 * MVP/dev path and the contract authority — the DBT models must emit the SAME
 * `DashboardMetrics` camelCase shape so the API/AI layers are storage-agnostic.
 *
 * MULTI-TENANCY: every query here runs on the `tx` handed in by `withTenant(orgId,
 * ...)`, so RLS scopes all reads to the caller's org. We never accept a raw Prisma
 * client and never widen the org filter. `orgId` is threaded through ONLY to stamp
 * the result envelope (DashboardMetrics.orgId), not to filter (RLS does that).
 *
 * SECTION 5d (skills/talent) is now WIRED to Module 6 (the skill graph in
 * src/lib/skillGraph.ts): it derives skill gaps, bus-factor risks, and a talent-
 * density index from the org-wide skill inventory. It keeps the graceful
 * `available:false` empty shape ONLY when the org has zero skills.
 *
 * SECTION 5c (engagement/retention) is now WIRED to Module 7 (the AttritionScore table
 * via lib/attritionScores.ts): it aggregates the latest score per employee into per-tier
 * counts, a department/level heatmap, and the regrettable-loss count. It keeps the
 * graceful `available:false` empty shape ONLY when the org has never been scored. eNPS
 * stays empty (no employee-survey integration).
 *
 * SECTION 5b's `internalMobilityRate` is now WIRED to Module 8 (the InternalApplication
 * table): internal HIRED moves in the last ~12 months ÷ active headcount (null when no
 * headcount). The rest of 5b (headcount/span/promotions/new-hire) is unchanged. The
 * DashboardMetrics contract is NOT changed — only the previously-null field is populated.
 */

// ── Tunable thresholds (spec 5a/5b) ──────────────────────────────────────────

/**
 * A role open longer than this (days) is an SLA breach (spec 5a: "roles open >N
 * days flagged in red"). In prod this would be configurable per org / per role
 * type via OrgSettings; the MVP uses a single org-wide constant.
 */
export const OPEN_ROLE_SLA_DAYS = 30;

/** Span-of-control bands (spec 5b: WIDE > 8 reports, NARROW < 3). */
export const SPAN_WIDE_THRESHOLD = 8;
export const SPAN_NARROW_THRESHOLD = 3;

/** A promotion counts toward the rate if it happened within this many days. */
const PROMOTION_WINDOW_DAYS = 365;

/** An internal move counts toward internalMobilityRate if it happened within this window. */
const INTERNAL_MOBILITY_WINDOW_DAYS = 365;

/** New-hire-success cohort: hired at least this long ago (past the 90-day mark). */
const NEW_HIRE_PROBATION_DAYS = 90;
/** ...but recently enough to be a meaningful "new hire" cohort (spec 5b: ~18mo). */
const NEW_HIRE_COHORT_DAYS = 18 * 30;
/** A "good" performance rating for the new-hire-success metric (spec: rating >= 3). */
const GOOD_REVIEW_RATING = 3;

/**
 * The ordered hiring pipeline stages between which we compute conversion rates
 * (spec 5a). REJECTED / WITHDRAWN are terminal off-ramps, not pipeline steps, so
 * they are excluded from the conversion chain (but still counted in `byStage`).
 */
const PIPELINE_STAGES: PrismaApplicationStage[] = [
  "APPLIED",
  "SCREENING",
  "INTERVIEW",
  "OFFER",
  "HIRED",
];

/** All stages we report a headcount for in `byStage` (full enum, stable order). */
const ALL_STAGES: PrismaApplicationStage[] = [
  ...PIPELINE_STAGES,
  "REJECTED",
  "WITHDRAWN",
];

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

/** A safe ratio in [0,1]; 0 when the denominator is 0 (no divide-by-zero NaN). */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const r = numerator / denominator;
  // Clamp defensively so a data anomaly can never violate the UnitScore contract.
  return Math.min(1, Math.max(0, r));
}

// ═══ 5a — Recruiting funnel ═══════════════════════════════════════════════════

/**
 * Compute the recruiting funnel: stage histogram, consecutive-stage conversion
 * rates, time-to-fill / time-to-hire, offer acceptance, source-of-hire, and open
 * roles past the SLA. Approximations are documented inline and in the README.
 */
async function computeRecruitingFunnel(
  tx: TxClient,
  now: Date,
): Promise<TRecruitingFunnel> {
  // ── byStage: histogram of applications by current stage ──────────────────────
  const stageGroups = await tx.application.groupBy({
    by: ["stage"],
    _count: { _all: true },
  });
  const stageCounts = new Map<PrismaApplicationStage, number>();
  for (const g of stageGroups) stageCounts.set(g.stage, g._count._all);

  const byStage = ALL_STAGES.map((stage) => ({
    stage,
    count: stageCounts.get(stage) ?? 0,
  }));

  const totalApplications = stageGroups.reduce((acc, g) => acc + g._count._all, 0);

  // ── conversionRates: rate between each consecutive pipeline stage ─────────────
  // Stage is the CURRENT stage, so an application now in INTERVIEW already passed
  // APPLIED + SCREENING. We approximate "reached stage S" as the count of apps at
  // S or any LATER pipeline stage, then rate(from→to) = reached(to)/reached(from).
  // This is the standard funnel approximation when only the current stage is stored
  // (prod DBT models would use the stage-transition event history for exactness).
  const reachedAtOrBeyond = (index: number): number => {
    let total = 0;
    for (let i = index; i < PIPELINE_STAGES.length; i += 1) {
      total += stageCounts.get(PIPELINE_STAGES[i]) ?? 0;
    }
    return total;
  };

  const conversionRates: TStageConversion[] = [];
  for (let i = 0; i < PIPELINE_STAGES.length - 1; i += 1) {
    const from = PIPELINE_STAGES[i];
    const to = PIPELINE_STAGES[i + 1];
    conversionRates.push({ from, to, rate: ratio(reachedAtOrBeyond(i + 1), reachedAtOrBeyond(i)) });
  }

  // ── openRoles + slaBreaches ──────────────────────────────────────────────────
  const openJobs = await tx.jobOpening.findMany({
    where: { status: "OPEN" },
    select: { id: true, title: true, createdAt: true },
  });
  const openRoles = openJobs.length;
  const slaBreaches = openJobs
    .map((j) => ({ jobId: j.id, title: j.title, daysOpen: Math.floor(daysBetween(j.createdAt, now)) }))
    .filter((j) => j.daysOpen > OPEN_ROLE_SLA_DAYS)
    .sort((a, b) => b.daysOpen - a.daysOpen);

  // ── timeToFillDays: avg days open→close for CLOSED jobs that were filled ──────
  // We approximate "filled" as any CLOSED job with a closedAt; a more precise prod
  // model would require the close to coincide with a HIRED application.
  const closedJobs = await tx.jobOpening.findMany({
    where: { status: "CLOSED", closedAt: { not: null } },
    select: { createdAt: true, closedAt: true },
  });
  const timeToFillDays = average(
    closedJobs
      .filter((j): j is { createdAt: Date; closedAt: Date } => j.closedAt != null)
      .map((j) => daysBetween(j.createdAt, j.closedAt))
      // Guard against clock skew / backfill (closedAt < createdAt), mirroring time-to-hire.
      .filter((d) => d >= 0),
  );

  // ── timeToHireDays: avg days application appliedAt → the hire ─────────────────
  // We approximate the "hire" timestamp with the HIRED application's updatedAt (the
  // moment it last moved — i.e. into HIRED). Exact "offer accept → start date" lives
  // in the prod DBT model; here we use the data the ATS schema actually carries.
  const hiredApps = await tx.application.findMany({
    where: { stage: "HIRED" },
    select: { appliedAt: true, updatedAt: true },
  });
  const timeToHireDays = average(
    hiredApps
      .map((a) => daysBetween(a.appliedAt, a.updatedAt))
      // Guard against clock skew / backfilled rows producing negatives.
      .filter((d) => d >= 0),
  );

  // ── offerAcceptanceRate: SIGNED offers / offers actually sent ─────────────────
  // "Sent" = any offer that left DRAFT/PENDING_APPROVAL (SENT, SIGNED, DECLINED,
  // EXPIRED). Acceptance = SIGNED. null when no offers were ever sent.
  const offerGroups = await tx.offer.groupBy({ by: ["status"], _count: { _all: true } });
  const offerCount = new Map<string, number>();
  for (const g of offerGroups) offerCount.set(g.status, g._count._all);
  const signed = offerCount.get("SIGNED") ?? 0;
  const sent =
    signed +
    (offerCount.get("SENT") ?? 0) +
    (offerCount.get("DECLINED") ?? 0) +
    (offerCount.get("EXPIRED") ?? 0);
  const offerAcceptanceRate = sent > 0 ? ratio(signed, sent) : null;

  // ── sourceOfHire: candidate.source for HIRED applications ─────────────────────
  // Group the candidates joined to HIRED applications by their acquisition source.
  const hiredForSource = await tx.application.findMany({
    where: { stage: "HIRED" },
    select: { candidate: { select: { source: true } } },
  });
  const sourceCounts = new Map<PrismaCandidateSource, number>();
  for (const a of hiredForSource) {
    const src = a.candidate.source;
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
  }
  const sourceOfHire = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  return RecruitingFunnel.parse({
    byStage,
    conversionRates,
    totalApplications,
    openRoles,
    timeToFillDays,
    timeToHireDays,
    offerAcceptanceRate,
    sourceOfHire,
    slaBreaches,
  });
}

// ═══ 5b — Workforce composition ═══════════════════════════════════════════════

/** Bucket an array of {key,count} from a groupBy result, dropping null keys. */
function headcountBuckets(
  groups: Array<{ key: string | null; count: number }>,
): Array<{ key: string; count: number }> {
  return groups
    .filter((g): g is { key: string; count: number } => g.key != null && g.key !== "")
    .map((g) => ({ key: g.key, count: g.count }))
    .sort((a, b) => b.count - a.count);
}

function spanFlag(directReports: number): TSpanFlag {
  if (directReports > SPAN_WIDE_THRESHOLD) return "WIDE";
  if (directReports < SPAN_NARROW_THRESHOLD) return "NARROW";
  return "OK";
}

/**
 * Compute workforce composition over ACTIVE employees: headcount buckets, span of
 * control, promotion rate by level, new-hire success, and internal mobility.
 */
async function computeWorkforceComposition(
  tx: TxClient,
  now: Date,
): Promise<TWorkforceComposition> {
  // Pull the ACTIVE employee population once; the buckets/aggregates are cheap to
  // derive in-memory and avoid five separate groupBy round-trips. For very large
  // orgs the prod DBT model materialises these; the MVP scale (≤5k employees) is
  // comfortably fine to aggregate here.
  const employees = await tx.employee.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      department: true,
      location: true,
      level: true,
      employmentType: true,
      managerId: true,
      hireDate: true,
      lastPromotionDate: true,
      lastReviewRating: true,
    },
  });

  const totalHeadcount = employees.length;

  // ── headcount buckets ────────────────────────────────────────────────────────
  const tally = (
    key: (e: (typeof employees)[number]) => string | null,
  ): Array<{ key: string; count: number }> => {
    const m = new Map<string, number>();
    for (const e of employees) {
      const k = key(e);
      if (k == null || k === "") continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return headcountBuckets([...m.entries()].map(([k, count]) => ({ key: k, count })));
  };

  const byDepartment = tally((e) => e.department);
  const byLocation = tally((e) => e.location);
  const byLevel = tally((e) => e.level);
  const byEmploymentType = tally((e) => e.employmentType);

  // ── spanOfControl: direct-report count per manager (only managers with reports) ─
  // We count reports among ACTIVE employees and resolve the manager's name from the
  // same active set; a manager who is themselves inactive still shows if they have
  // active reports (their name resolves to null then, which the contract allows).
  const nameById = new Map<string, string | null>();
  for (const e of employees) nameById.set(e.id, e.name);

  const reportsByManager = new Map<string, number>();
  for (const e of employees) {
    if (e.managerId == null) continue;
    reportsByManager.set(e.managerId, (reportsByManager.get(e.managerId) ?? 0) + 1);
  }
  const spanOfControl = [...reportsByManager.entries()]
    .map(([managerId, directReports]) => ({
      managerId,
      managerName: nameById.get(managerId) ?? null,
      directReports,
      flag: spanFlag(directReports),
    }))
    .sort((a, b) => b.directReports - a.directReports);

  // ── promotionRateByLevel: per level, promoted-in-window / total at level ───────
  const promotionWindowStart = new Date(now.getTime() - PROMOTION_WINDOW_DAYS * MS_PER_DAY);
  const levelTotals = new Map<PrismaRoleLevel, { promoted: number; total: number }>();
  for (const e of employees) {
    if (e.level == null) continue;
    const bucket = levelTotals.get(e.level) ?? { promoted: 0, total: 0 };
    bucket.total += 1;
    if (e.lastPromotionDate != null && e.lastPromotionDate >= promotionWindowStart) {
      bucket.promoted += 1;
    }
    levelTotals.set(e.level, bucket);
  }
  const promotionRateByLevel = [...levelTotals.entries()]
    .map(([level, b]) => ({ level, promoted: b.promoted, total: b.total, rate: ratio(b.promoted, b.total) }))
    .sort((a, b) => b.total - a.total);

  // ── newHireSuccessRate: of recent new hires past 90 days, % with rating >= 3 ───
  // Cohort = hired between (now-18mo) and (now-90d), i.e. they have cleared the
  // probation mark but are still "new". null if the cohort is empty (spec 5b).
  const cohortEarliest = new Date(now.getTime() - NEW_HIRE_COHORT_DAYS * MS_PER_DAY);
  const cohortLatest = new Date(now.getTime() - NEW_HIRE_PROBATION_DAYS * MS_PER_DAY);
  const cohort = employees.filter(
    (e) => e.hireDate != null && e.hireDate >= cohortEarliest && e.hireDate <= cohortLatest,
  );
  const newHireSuccessRate =
    cohort.length > 0
      ? ratio(
          cohort.filter((e) => e.lastReviewRating != null && e.lastReviewRating >= GOOD_REVIEW_RATING).length,
          cohort.length,
        )
      : null;

  // ── internalMobilityRate: WIRED to Module 8 (InternalApplication) ─────────────
  // The share of the active workforce that moved internally in the last ~12 months:
  // internal HIRED moves in the window ÷ active headcount. An InternalApplication with
  // status HIRED is an internal move; we date it by `updatedAt` (when it last moved —
  // i.e. into HIRED), the same approximation the recruiting funnel uses for time-to-hire.
  // null when there is no active headcount (the rate is undefined — spec 5b allows null).
  let internalMobilityRate: number | null = null;
  if (totalHeadcount > 0) {
    const mobilityWindowStart = new Date(
      now.getTime() - INTERNAL_MOBILITY_WINDOW_DAYS * MS_PER_DAY,
    );
    const internalHiresInWindow = await tx.internalApplication.count({
      where: { status: "HIRED", updatedAt: { gte: mobilityWindowStart } },
    });
    internalMobilityRate = ratio(internalHiresInWindow, totalHeadcount);
  }

  return WorkforceComposition.parse({
    totalHeadcount,
    byDepartment,
    byLocation,
    byLevel,
    byEmploymentType,
    spanOfControl,
    promotionRateByLevel,
    newHireSuccessRate,
    internalMobilityRate,
  });
}

// ═══ 5c / 5d — engagement (Module 7) + skills (Module 6); degrade gracefully ═══

/**
 * 5c Engagement & retention — WIRED to Module 7 (AttritionScore).
 *
 * Aggregates the LATEST attrition score per employee into:
 *   - attritionByTier  : per-tier counts (CRITICAL/HIGH/MEDIUM/LOW, zero-filled).
 *   - attritionHeatmap : count per (DEPARTMENT|LEVEL, group, tier) cell.
 *   - regrettableCount : strong performers (perf rating ≥ 4) at CRITICAL/HIGH risk.
 *
 * available:true once ANY attrition score exists; we keep the graceful available:false
 * empty shape (+ a pendingReason) ONLY when the org has been scored zero times, so the
 * section degrades cleanly for an org that has not run scoring yet — without a contract
 * change. eNPS stays EMPTY: there is no employee-survey integration (documented).
 *
 * The "latest score" definition + tier ordering are shared with routes/attrition.ts via
 * lib/attritionScores.ts so the dashboard and the Module 7 summary never diverge.
 */
async function computeEngagement(tx: TxClient): Promise<EngagementRetention> {
  const latest = await loadLatestScores(tx);

  // Never scored → keep the graceful "not yet populated" shape (eNPS always empty).
  if (latest.size === 0) {
    return EngagementRetention.parse({
      available: false,
      pendingReason: "Awaiting Module 7 attrition scores",
      attritionByTier: [],
      attritionHeatmap: [],
      regrettableCount: 0,
      enpsTrend: [],
    });
  }

  const scores = [...latest.values()];
  const attritionByTier = countByTier(scores);

  // Join scored employees with their department/level/perf for the heatmap + the
  // regrettable-loss count.
  const ids = [...latest.keys()];
  const employees = await tx.employee.findMany({
    where: { id: { in: ids } },
    select: { id: true, department: true, level: true, lastReviewRating: true },
  });
  const empById = new Map(employees.map((e) => [e.id, e]));

  const cellCounts = new Map<string, TAttritionHeatCell>();
  const bump = (dimension: "DEPARTMENT" | "LEVEL", group: string, tier: TRiskTier): void => {
    const key = `${dimension} ${group} ${tier}`;
    const existing = cellCounts.get(key);
    if (existing) existing.count += 1;
    else cellCounts.set(key, { dimension, group, tier, count: 1 });
  };

  let regrettableCount = 0;
  for (const s of scores) {
    const emp = empById.get(s.employeeId);
    if (emp?.department) bump("DEPARTMENT", emp.department, s.riskTier);
    if (emp?.level) bump("LEVEL", emp.level, s.riskTier);
    if (isRegrettable(s.riskTier, emp?.lastReviewRating ?? null)) regrettableCount += 1;
  }

  const attritionHeatmap = [...cellCounts.values()].sort(
    (a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      a.group.localeCompare(b.group) ||
      a.tier.localeCompare(b.tier),
  );

  return EngagementRetention.parse({
    available: true,
    pendingReason: null,
    attritionByTier,
    attritionHeatmap,
    regrettableCount,
    // No employee-survey integration → eNPS trend stays empty (documented).
    enpsTrend: [],
  });
}

/**
 * 5d Skills & talent density — WIRED to the Module 6 skill graph (src/lib/skillGraph).
 *
 * Derived from the org-wide skill inventory (per-skill supply vs OPEN-role demand):
 *   - skillGaps        : skills where demand > supply (under-supplied), worst gap first.
 *                        Mapped to the analytics `SkillGap` shape ({skill, required,
 *                        supply, gap}) — `required` = open-role demand.
 *   - busFactorRisks   : skills held by exactly ONE employee org-wide (bus-factor),
 *                        as the analytics `BusFactorRisk` shape ({skill, holders}).
 *   - talentDensityIndex: the inventory's org-level density signal (share of in-demand
 *                        skills met internally; null if nothing is demanded).
 *
 * available:true once the skill graph holds ANY skill; we keep the graceful
 * available:false empty shape ONLY when the org has zero skills (nothing to report
 * yet), so the section degrades cleanly for a brand-new org without a contract change.
 */
async function computeSkillsTalent(tx: TxClient): Promise<SkillsTalent> {
  const inventory = await skillInventory(tx);

  // Empty graph → keep the graceful "not yet populated" shape (spec 5d).
  if (inventory.items.length === 0) {
    return SkillsTalent.parse({
      available: false,
      pendingReason: "No skills in the org skill graph yet",
      skillGaps: [],
      busFactorRisks: [],
      talentDensityIndex: null,
    });
  }

  // Under-supplied skills: demand exceeds supply. Map to the analytics SkillGap shape
  // (`required` = open-role demand), worst (largest positive gap) first.
  const skillGaps = inventory.items
    .filter((i) => i.demand > i.supply)
    .map((i) => ({ skill: i.skillName, required: i.demand, supply: i.supply, gap: i.gap }))
    .sort((a, b) => b.gap - a.gap || a.skill.localeCompare(b.skill));

  // Bus-factor risk: a skill held by exactly ONE employee org-wide (supply === 1).
  const busFactorRisks = inventory.items
    .filter((i) => i.supply === 1)
    .map((i) => ({ skill: i.skillName, holders: 1 }))
    .sort((a, b) => a.skill.localeCompare(b.skill));

  return SkillsTalent.parse({
    available: true,
    pendingReason: null,
    skillGaps,
    busFactorRisks,
    talentDensityIndex: inventory.talentDensityIndex,
  });
}

// ═══ Dashboard ════════════════════════════════════════════════════════════════

/**
 * Compute the full Module 5 dashboard for one org. MUST be called inside
 * `withTenant(orgId, (tx) => computeDashboard(tx, orgId))` so every query is RLS
 * org-scoped. Returns a validated `DashboardMetrics` (parse throws on any contract
 * violation, so a downstream consumer — incl. the AI narrative — only ever sees a
 * conformant snapshot).
 *
 * `now` is injectable for deterministic tests; defaults to the current time.
 */
export async function computeDashboard(
  tx: TxClient,
  orgId: string,
  now: Date = new Date(),
): Promise<TDashboardMetrics> {
  const [recruiting, workforce, engagement, skills] = await Promise.all([
    computeRecruitingFunnel(tx, now),
    computeWorkforceComposition(tx, now),
    computeEngagement(tx),
    computeSkillsTalent(tx),
  ]);

  return DashboardMetrics.parse({
    orgId,
    generatedAt: now.toISOString(),
    recruiting,
    workforce,
    engagement,
    skills,
  });
}
