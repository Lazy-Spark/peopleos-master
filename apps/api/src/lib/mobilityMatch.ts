import {
  MobilityAnalytics,
  RecommendedGigs,
  RecommendedRoles,
  Readiness,
  RoleMatchResult,
  SuccessionPlan,
  GigStatus,
  RoleLevel,
  JDStructured,
  type GigMatch as TGigMatch,
  type InternalCandidate as TInternalCandidate,
  type MobilityAnalytics as TMobilityAnalytics,
  type Readiness as TReadiness,
  type RecommendedGigs as TRecommendedGigs,
  type RecommendedRole as TRecommendedRole,
  type RecommendedRoles as TRecommendedRoles,
  type RiskTier as TRiskTier,
  type RoleLevel as TRoleLevel,
  type RoleMatchResult as TRoleMatchResult,
  type SuccessionCandidate as TSuccessionCandidate,
  type SuccessionPlan as TSuccessionPlan,
} from "@peopleos/schemas";
import type { TxClient } from "../db.js";
import { notFound } from "./errors.js";
import { skillGap } from "./skillGraph.js";
import { loadLatestScores, type LatestScore } from "./attritionScores.js";

/**
 * Module 8 — Internal Talent Marketplace matching primitives (all take the `tx`
 * handed in by `withTenant(orgId, …)`, so RLS scopes every read to the caller's org).
 *
 * MATCHING IS SKILL-GRAPH DRIVEN. The single source of truth for an (employee, role)
 * pair is Module 6's `skillGraph.skillGap`, which returns matched/missing skill names,
 * `gapSize` (= |missing|) and `coverage` (= matched / required, vacuously 1 when the
 * role lists no required skills). From that one report we derive:
 *   - matchScore = coverage (a UnitScore in [0,1]).
 *   - readiness  = a band over coverage + gap size (READY_NOW / READY_SOON / STRETCH).
 *     READY_NOW  : coverage ≥ 0.9 AND gap ≤ 1 (essentially ready, at most one small gap)
 *     READY_SOON : coverage ≥ 0.6 (a meaningful, closeable gap)
 *     STRETCH    : below that (a development move)
 * so the same definition is shared by recommended-roles, internal-candidates, and
 * succession. Reusing `skillGap` means Module 8 never re-implements the name-matching /
 * JD-parsing logic and stays consistent with the Module 6 growth-path's `stepsAway`.
 *
 * GOVERNANCE: flight-risk is the Module 7 attrition TIER ONLY (never the raw score),
 * and is attached to internal candidates / successors ONLY when the caller passes
 * `includeFlightRisk` (the route gates that on an ADMIN/HRBP viewer); it is `null` for
 * everyone else. No `any`; every result is parsed against its frozen contract.
 */

// ── Readiness thresholds (documented; shared by every matcher) ────────────────
/** Coverage at/above this with a tiny gap → READY_NOW. */
export const READY_NOW_COVERAGE = 0.9;
/** A READY_NOW move may have at most this many missing skills. */
export const READY_NOW_MAX_GAP = 1;
/** Coverage at/above this (but not READY_NOW) → READY_SOON; below → STRETCH. */
export const READY_SOON_COVERAGE = 0.6;

/** Derive the readiness band from skill coverage + gap size (documented thresholds). */
export function readinessFor(coverage: number, gapSize: number): TReadiness {
  if (coverage >= READY_NOW_COVERAGE && gapSize <= READY_NOW_MAX_GAP) {
    return Readiness.enum.READY_NOW;
  }
  if (coverage >= READY_SOON_COVERAGE) return Readiness.enum.READY_SOON;
  return Readiness.enum.STRETCH;
}

/** A role is part of the "bench" once an employee has ANY skill overlap with it. */
function onBench(matchedCount: number): boolean {
  return matchedCount > 0;
}

/** Lower-case + trim a skill name for case-insensitive matching of held vs required. */
function normaliseSkillName(name: string): string {
  return name.trim().toLowerCase();
}

/** Narrow a free-string DB level column → the frozen RoleLevel enum (null-tolerant). */
function level(raw: string | null): TRoleLevel | null {
  if (raw == null) return null;
  const parsed = RoleLevel.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The skill-graph match facts for one (employee, role) pair, used by every matcher. */
interface MatchFacts {
  matchScore: number;
  readiness: TReadiness;
  matchedSkills: string[];
  missingSkills: string[];
  gapSize: number;
}

/**
 * Compute the skill-graph match facts for one (employee, role) pair by REUSING
 * Module 6's `skillGap`. `matchScore` = coverage; readiness is banded from coverage +
 * gap size. This is the single matching primitive every Module 8 surface goes through.
 */
async function matchEmployeeToRole(
  tx: TxClient,
  employeeId: string,
  jobOpeningId: string,
): Promise<MatchFacts> {
  const gap = await skillGap(tx, employeeId, jobOpeningId);
  return {
    matchScore: gap.coverage,
    readiness: readinessFor(gap.coverage, gap.gapSize),
    matchedSkills: gap.matched,
    missingSkills: gap.missing,
    gapSize: gap.gapSize,
  };
}

// ═══ 8a — Recommended roles for an employee ═══════════════════════════════════
/**
 * "Recommended for you" — the OPEN internal roles ranked by how well an employee's
 * skills cover each role's required skills. `alreadyApplied` is set from the
 * employee's existing `InternalApplication` rows. Ranked by matchScore desc, then by
 * title for a stable order. 404 if the employee is not in this tenant.
 */
export async function recommendedRoles(
  tx: TxClient,
  employeeId: string,
): Promise<TRecommendedRoles> {
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { id: true },
  });
  if (!employee) throw notFound(`Employee ${employeeId} not found`);

  const openRoles = await tx.jobOpening.findMany({
    where: { status: "OPEN" },
    select: { id: true, title: true, department: true, level: true },
    orderBy: { title: "asc" },
  });

  // Which OPEN roles has this employee already expressed interest in / applied to?
  const existing = await tx.internalApplication.findMany({
    where: { employeeId, jobOpeningId: { in: openRoles.map((r) => r.id) } },
    select: { jobOpeningId: true },
  });
  const appliedRoleIds = new Set(existing.map((a) => a.jobOpeningId));

  const roles: TRecommendedRole[] = [];
  for (const role of openRoles) {
    const facts = await matchEmployeeToRole(tx, employeeId, role.id);
    roles.push({
      jobOpeningId: role.id,
      title: role.title,
      department: role.department,
      level: level(role.level),
      matchScore: facts.matchScore,
      readiness: facts.readiness,
      matchedSkills: facts.matchedSkills,
      missingSkills: facts.missingSkills,
      gapSize: facts.gapSize,
      alreadyApplied: appliedRoleIds.has(role.id),
    });
  }

  // Rank by best coverage first; tie-break on title for determinism.
  roles.sort((a, b) => b.matchScore - a.matchScore || a.title.localeCompare(b.title));

  return RecommendedRoles.parse({ employeeId: employee.id, roles });
}

// ═══ 8b — Internal candidates for a role ("who can fill this role?") ═══════════
/**
 * The internal candidates for one OPEN/any role: every ACTIVE employee ranked by how
 * well they cover the role's required skills. `flightRisk` is the Module 7 attrition
 * TIER ONLY — and is attached ONLY when `includeFlightRisk` is true (the route gates
 * that on an ADMIN/HRBP viewer); it is `null` for everyone else (governance). Ranked by
 * matchScore desc, then employee name. 404 if the role is not in this tenant.
 */
export async function internalCandidates(
  tx: TxClient,
  jobOpeningId: string,
  includeFlightRisk: boolean,
): Promise<TRoleMatchResult> {
  const role = await tx.jobOpening.findUnique({
    where: { id: jobOpeningId },
    select: { id: true, title: true, jdStructured: true },
  });
  if (!role) throw notFound(`Role ${jobOpeningId} not found`);

  // The role's required skill names (from the structured JD), de-duplicated
  // case-insensitively to mirror skillGap's required set.
  const requiredSkills = requiredSkillNames(role.jdStructured);

  const employees = await tx.employee.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, department: true, level: true },
    orderBy: { name: "asc" },
  });

  // Flight risk is the attrition TIER only, surfaced to ADMIN/HRBP viewers ONLY.
  const scores = includeFlightRisk ? await loadLatestScores(tx) : null;

  const candidates: TInternalCandidate[] = [];
  for (const e of employees) {
    const facts = await matchEmployeeToRole(tx, e.id, role.id);
    candidates.push({
      employeeId: e.id,
      employeeName: e.name,
      department: e.department,
      level: level(e.level),
      matchScore: facts.matchScore,
      readiness: facts.readiness,
      matchedSkills: facts.matchedSkills,
      missingSkills: facts.missingSkills,
      gapSize: facts.gapSize,
      flightRisk: flightRiskTier(scores, e.id),
    });
  }

  candidates.sort(
    (a, b) => b.matchScore - a.matchScore || (a.employeeName ?? "").localeCompare(b.employeeName ?? ""),
  );

  return RoleMatchResult.parse({
    jobOpeningId: role.id,
    title: role.title,
    requiredSkills,
    candidates,
  });
}

// ═══ 8d — Succession plan for a role ══════════════════════════════════════════
/**
 * The succession plan for a (typically senior/critical) role: the internal bench
 * ranked by readiness, with readyNow / readySoon counts and benchStrength (# internal
 * candidates with ANY meaningful skill coverage). Flight risk is the attrition TIER
 * only and is ALWAYS computed here — succession is an ADMIN/HRBP-only surface, so the
 * route restricts the viewer; `null` for an employee without a current score. 404 if
 * the role is not in this tenant.
 */
export async function successionPlan(
  tx: TxClient,
  jobOpeningId: string,
): Promise<TSuccessionPlan> {
  const role = await tx.jobOpening.findUnique({
    where: { id: jobOpeningId },
    select: { id: true, title: true },
  });
  if (!role) throw notFound(`Role ${jobOpeningId} not found`);

  const employees = await tx.employee.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, level: true },
    orderBy: { name: "asc" },
  });
  // Succession is ADMIN/HRBP-only (route-gated), so flight-risk tier is always loaded.
  const scores = await loadLatestScores(tx);

  const successors: TSuccessionCandidate[] = [];
  let readyNow = 0;
  let readySoon = 0;
  let benchStrength = 0;
  for (const e of employees) {
    const facts = await matchEmployeeToRole(tx, e.id, role.id);
    // Bench = anyone with ANY skill overlap with the role.
    if (onBench(facts.matchedSkills.length)) benchStrength += 1;
    if (facts.readiness === Readiness.enum.READY_NOW) readyNow += 1;
    else if (facts.readiness === Readiness.enum.READY_SOON) readySoon += 1;

    successors.push({
      employeeId: e.id,
      employeeName: e.name,
      level: level(e.level),
      readiness: facts.readiness,
      matchScore: facts.matchScore,
      gapSize: facts.gapSize,
      flightRisk: flightRiskTier(scores, e.id),
    });
  }

  // Best-ready first; tie-break on coverage then name for a stable order.
  successors.sort(
    (a, b) =>
      readinessRank(a.readiness) - readinessRank(b.readiness) ||
      b.matchScore - a.matchScore ||
      (a.employeeName ?? "").localeCompare(b.employeeName ?? ""),
  );

  return SuccessionPlan.parse({
    jobOpeningId: role.id,
    roleTitle: role.title,
    benchStrength,
    readyNow,
    readySoon,
    successors,
  });
}

/** Readiness sort rank (READY_NOW first). */
function readinessRank(r: TReadiness): number {
  switch (r) {
    case "READY_NOW":
      return 0;
    case "READY_SOON":
      return 1;
    case "STRETCH":
      return 2;
  }
}

// ═══ 8c — Recommended gigs for an employee ════════════════════════════════════
/**
 * "Recommended gigs" — the OPEN gigs ranked by how well an employee's skills cover
 * each gig's `requiredSkills` (a free-text string array on the Gig, NOT the JD parse,
 * so we match names case-insensitively against the employee's held skills). matchScore
 * = matched / required (1 when a gig lists no required skills). Ranked by matchScore
 * desc, then title. 404 if the employee is not in this tenant.
 */
export async function recommendedGigs(
  tx: TxClient,
  employeeId: string,
): Promise<TRecommendedGigs> {
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { id: true },
  });
  if (!employee) throw notFound(`Employee ${employeeId} not found`);

  // The employee's held skill names (case-insensitive index).
  const records = await tx.skillRecord.findMany({
    where: { employeeId },
    include: { skill: { select: { canonicalName: true } } },
  });
  const heldByNorm = new Set(records.map((r) => normaliseSkillName(r.skill.canonicalName)));

  const openGigs = await tx.gig.findMany({
    where: { status: GigStatus.enum.OPEN },
    select: { id: true, title: true, requiredSkills: true, durationWeeks: true },
    orderBy: { title: "asc" },
  });

  const gigs: TGigMatch[] = openGigs.map((g) => {
    // De-duplicate a gig's required skills case-insensitively (free-text input).
    const required: string[] = [];
    const seen = new Set<string>();
    for (const s of g.requiredSkills) {
      const norm = normaliseSkillName(s);
      if (norm === "" || seen.has(norm)) continue;
      seen.add(norm);
      required.push(s);
    }

    const matchedSkills: string[] = [];
    const missingSkills: string[] = [];
    for (const reqName of required) {
      if (heldByNorm.has(normaliseSkillName(reqName))) matchedSkills.push(reqName);
      else missingSkills.push(reqName);
    }
    const matchScore = required.length === 0 ? 1 : matchedSkills.length / required.length;

    return {
      gigId: g.id,
      title: g.title,
      matchScore,
      matchedSkills,
      missingSkills,
      durationWeeks: g.durationWeeks,
    };
  });

  gigs.sort((a, b) => b.matchScore - a.matchScore || a.title.localeCompare(b.title));

  return RecommendedGigs.parse({ employeeId: employee.id, gigs });
}

// ═══ Mobility analytics (feeds Module 5 5b internalMobilityRate) ══════════════
/**
 * Org-wide internal-mobility metrics from `InternalApplication` + `Employee`:
 *   - internalFillRate  : internal HIRED moves ÷ total internal applications (the
 *                         share of internal applications that resulted in a hire); null
 *                         when there are no internal applications.
 *   - internalMobilityRate : internal HIRED moves ÷ active headcount; null when there
 *                         is no headcount.
 *   - openInternalRoles : # OPEN JobOpenings (the internal job board surface).
 *   - totalInternalApplications / hiredInternally : raw counts.
 *   - byDepartment      : internal hires bucketed by the hired employee's department.
 * Every ratio guards divide-by-zero (returns null rather than NaN).
 */
export async function mobilityAnalytics(tx: TxClient): Promise<TMobilityAnalytics> {
  const [totalInternalApplications, hiredInternally, openInternalRoles, activeHeadcount] =
    await Promise.all([
      tx.internalApplication.count(),
      tx.internalApplication.count({ where: { status: "HIRED" } }),
      tx.jobOpening.count({ where: { status: "OPEN" } }),
      tx.employee.count({ where: { status: "ACTIVE" } }),
    ]);

  // internalFillRate: of all internal applications, the share that resulted in a hire.
  // null (not 0) when there are no internal applications — the rate is undefined.
  const internalFillRate =
    totalInternalApplications > 0 ? hiredInternally / totalInternalApplications : null;

  // internalMobilityRate: internal hires per active headcount. null when no headcount.
  const internalMobilityRate =
    activeHeadcount > 0 ? Math.min(1, hiredInternally / activeHeadcount) : null;

  // byDepartment: internal hires bucketed by the HIRED employee's department.
  const hiredApps = await tx.internalApplication.findMany({
    where: { status: "HIRED" },
    select: { employee: { select: { department: true } } },
  });
  const deptCounts = new Map<string, number>();
  for (const a of hiredApps) {
    const dept = a.employee.department;
    if (dept == null || dept === "") continue;
    deptCounts.set(dept, (deptCounts.get(dept) ?? 0) + 1);
  }
  const byDepartment = [...deptCounts.entries()]
    .map(([department, internalHires]) => ({ department, internalHires }))
    .sort((a, b) => b.internalHires - a.internalHires || a.department.localeCompare(b.department));

  return MobilityAnalytics.parse({
    internalFillRate,
    internalMobilityRate,
    openInternalRoles,
    totalInternalApplications,
    hiredInternally,
    byDepartment,
  });
}

// ── shared helpers ────────────────────────────────────────────────────────────

/** The role's required skill names from its structured JD, de-duplicated case-insensitively. */
function requiredSkillNames(jdStructured: unknown): string[] {
  if (jdStructured == null) return [];
  const parsed = JDStructured.safeParse(jdStructured);
  if (!parsed.success) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const s of parsed.data.requiredSkills) {
    const norm = normaliseSkillName(s.canonicalName);
    if (seen.has(norm)) continue;
    seen.add(norm);
    names.push(s.canonicalName);
  }
  return names;
}

/**
 * The Module 7 attrition TIER for an employee (governance: tier ONLY, never the raw
 * score). Returns null when scores are not loaded (non-ADMIN/HRBP viewer) or the
 * employee has no current score.
 */
function flightRiskTier(
  scores: Map<string, LatestScore> | null,
  employeeId: string,
): TRiskTier | null {
  if (!scores) return null;
  return scores.get(employeeId)?.riskTier ?? null;
}
