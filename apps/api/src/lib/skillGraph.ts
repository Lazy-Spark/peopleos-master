import {
  EmployeeSkillProfile,
  JDStructured,
  ProficiencyLevel,
  SkillCategory,
  SkillGapReport,
  SkillInventory,
  SkillSource,
  TeamSkillMap,
  WhoHasSkillResult,
  type EmployeeSkillProfile as TEmployeeSkillProfile,
  type SkillGapReport as TSkillGapReport,
  type SkillInventory as TSkillInventory,
  type TeamSkillMap as TTeamSkillMap,
  type WhoHasSkillResult as TWhoHasSkillResult,
} from "@peopleos/schemas";
import type { TxClient } from "../db.js";
import { notFound } from "./errors.js";

/**
 * Module 6 — Employee Skill Graph queries (spec Layer 3A "Skill Knowledge Graph").
 *
 * The graph is modelled RELATIONALLY in Postgres (Neo4j is the documented prod
 * adapter): a `Skill` node, an `Employee` node (Module 5, with a self-relation
 * managerId↔reports = the REPORTS_TO edge), and a `SkillRecord` join row that is the
 * (Employee)-[HAS_SKILL]->(Skill) edge carrying proficiency + confidence + source +
 * verification. The six spec query patterns are therefore computed in-API via Prisma
 * joins rather than Cypher.
 *
 * MULTI-TENANCY: every function takes the `tx` handed in by `withTenant(orgId, ...)`,
 * so RLS scopes ALL reads to the caller's org (prisma/rls.sql). We never accept a bare
 * Prisma client and never widen the org filter. Confidence is ALWAYS derived from the
 * record's `source` server-side (confidenceForSource) — never client-supplied — and is
 * surfaced read-only here straight off the persisted `confidenceScore` column.
 *
 * Every result is validated against its frozen @peopleos/schemas contract before it is
 * returned, so a downstream consumer (route serializer, AI request, Module 5 wiring)
 * only ever sees a conformant shape. No `any`; the free-string DB columns
 * (category/proficiency/source) are narrowed through their Zod enums on read.
 */

/** Narrow a free-string `Skill.category` DB column to the frozen enum. */
function category(raw: string): SkillCategory {
  return SkillCategory.parse(raw);
}

/** Narrow a free-string `SkillRecord.proficiency` DB column to the frozen enum. */
function proficiency(raw: string): ProficiencyLevel {
  return ProficiencyLevel.parse(raw);
}

/** Narrow a free-string `SkillRecord.source` DB column to the frozen enum. */
function source(raw: string): SkillSource {
  return SkillSource.parse(raw);
}

/**
 * 6a — Employee skill profile. The (Employee)-[HAS_SKILL]->(Skill) edges for one
 * employee, joined with each skill's display name + category. Returns the employee's
 * resolved name (null if the employee row carries none). 404 if the employee is not in
 * this tenant (RLS-scoped), so a missing/cross-org id is a clean not-found rather than
 * an empty profile that looks real.
 */
export async function employeeSkillProfile(
  tx: TxClient,
  employeeId: string,
): Promise<TEmployeeSkillProfile> {
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, name: true },
  });
  if (!employee) throw notFound(`Employee ${employeeId} not found`);

  const records = await tx.skillRecord.findMany({
    where: { employeeId },
    include: { skill: { select: { canonicalName: true, category: true } } },
    orderBy: { confidenceScore: "desc" },
  });

  return EmployeeSkillProfile.parse({
    employeeId: employee.id,
    employeeName: employee.name,
    skills: records.map((r) => ({
      id: r.id,
      skillId: r.skillId,
      skillName: r.skill.canonicalName,
      category: category(r.skill.category),
      proficiency: proficiency(r.proficiency),
      confidenceScore: r.confidenceScore,
      source: source(r.source),
      verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    })),
  });
}

/**
 * "Who in the org has skill X?" (spec query pattern 1). All employees holding the
 * given skill, with their proficiency + (source-derived) confidence, best-first.
 * 404 if the skill is not in this tenant.
 */
export async function whoHasSkill(
  tx: TxClient,
  skillId: string,
): Promise<TWhoHasSkillResult> {
  const skill = await tx.skill.findUnique({
    where: { id: skillId },
    select: { id: true, canonicalName: true },
  });
  if (!skill) throw notFound(`Skill ${skillId} not found`);

  const records = await tx.skillRecord.findMany({
    where: { skillId },
    include: { employee: { select: { id: true, name: true } } },
    orderBy: [{ confidenceScore: "desc" }],
  });

  return WhoHasSkillResult.parse({
    skillId: skill.id,
    skillName: skill.canonicalName,
    holders: records.map((r) => ({
      employeeId: r.employee.id,
      employeeName: r.employee.name,
      proficiency: proficiency(r.proficiency),
      confidenceScore: r.confidenceScore,
    })),
  });
}

/** Lowercase + trim a skill name for case-insensitive matching of required vs held. */
function normaliseSkillName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * "What is the skill gap for employee Y to be ready for role Z?" (spec query pattern
 * 3). `required` = the target role's `JobOpening.jdStructured.requiredSkills`
 * canonicalNames; matched/missing are computed against the employee's held skills by
 * CASE-INSENSITIVE name match. `gapSize` = |missing|; `coverage` = matched / required
 * (1 when the role lists no required skills — vacuously fully covered).
 *
 * 404 if either the employee or the target role is not in this tenant. The role must
 * have a parsed `jdStructured`; an unparsed JD yields an empty required set
 * (coverage 1, gapSize 0) which the README documents.
 */
export async function skillGap(
  tx: TxClient,
  employeeId: string,
  targetRoleId: string,
): Promise<TSkillGapReport> {
  const [employee, role] = await Promise.all([
    tx.employee.findUnique({ where: { id: employeeId }, select: { id: true } }),
    tx.jobOpening.findUnique({
      where: { id: targetRoleId },
      select: { id: true, title: true, jdStructured: true },
    }),
  ]);
  if (!employee) throw notFound(`Employee ${employeeId} not found`);
  if (!role) throw notFound(`Target role ${targetRoleId} not found`);

  // The required skills come from the role's structured JD parse. An unparsed JD →
  // no required skills (the gap is vacuously satisfied); a parse here is tolerant.
  const parsedJd = role.jdStructured == null ? null : JDStructured.safeParse(role.jdStructured);
  // De-duplicate required skills case-insensitively (a JD parse can repeat a skill), so
  // gapSize/coverage here agree with the AI growth-path's stepsAway (which also dedups).
  const requiredSkills: string[] = [];
  const seenRequired = new Set<string>();
  for (const s of parsedJd && parsedJd.success ? parsedJd.data.requiredSkills : []) {
    const norm = normaliseSkillName(s.canonicalName);
    if (seenRequired.has(norm)) continue;
    seenRequired.add(norm);
    requiredSkills.push(s.canonicalName);
  }

  const records = await tx.skillRecord.findMany({
    where: { employeeId },
    include: { skill: { select: { canonicalName: true } } },
  });
  const heldByNorm = new Map<string, string>();
  for (const r of records) {
    heldByNorm.set(normaliseSkillName(r.skill.canonicalName), r.skill.canonicalName);
  }

  const matched: string[] = [];
  const missing: string[] = [];
  for (const reqName of requiredSkills) {
    if (heldByNorm.has(normaliseSkillName(reqName))) matched.push(reqName);
    else missing.push(reqName);
  }

  const coverage = requiredSkills.length === 0 ? 1 : matched.length / requiredSkills.length;

  return SkillGapReport.parse({
    employeeId: employee.id,
    targetRoleId: role.id,
    targetRoleTitle: role.title,
    requiredSkills,
    matched,
    missing,
    gapSize: missing.length,
    coverage,
  });
}

/**
 * 6b — Team skill map over a manager's direct reports (Employee.managerId = the
 * REPORTS_TO edge). Per-member skills, a BUS-FACTOR list (skills held by exactly ONE
 * report — spec 6b "skills held by only 1 team member"), and BENCH STRENGTH (holder
 * count per skill across the team). 404 if the manager is not in this tenant.
 *
 * "Held by one report" counts distinct REPORTS holding the skill, not records, so a
 * single report can never inflate bench strength by holding the same skill twice (the
 * DB unique [employeeId, skillId] already prevents that, but we count distinctly to be
 * robust). Lists are sorted deterministically (bus-factor + bench by name).
 */
export async function teamSkillMap(
  tx: TxClient,
  managerId: string,
): Promise<TTeamSkillMap> {
  const manager = await tx.employee.findUnique({
    where: { id: managerId },
    select: { id: true },
  });
  if (!manager) throw notFound(`Manager ${managerId} not found`);

  const reports = await tx.employee.findMany({
    where: { managerId },
    select: {
      id: true,
      name: true,
      skillRecords: {
        include: { skill: { select: { id: true, canonicalName: true } } },
      },
    },
    orderBy: { name: "asc" },
  });

  const members = reports.map((e) => ({
    employeeId: e.id,
    employeeName: e.name,
    skills: e.skillRecords.map((r) => ({
      skillName: r.skill.canonicalName,
      proficiency: proficiency(r.proficiency),
      confidenceScore: r.confidenceScore,
    })),
  }));

  // holders-per-skill across the team: how many DISTINCT reports hold each skill.
  const holdersBySkill = new Map<string, { name: string; holders: Set<string> }>();
  for (const e of reports) {
    for (const r of e.skillRecords) {
      const entry = holdersBySkill.get(r.skill.id) ?? { name: r.skill.canonicalName, holders: new Set<string>() };
      entry.holders.add(e.id);
      holdersBySkill.set(r.skill.id, entry);
    }
  }

  const benchStrength = [...holdersBySkill.entries()]
    .map(([skillId, v]) => ({ skillId, skillName: v.name, count: v.holders.size }))
    .sort((a, b) => b.count - a.count || a.skillName.localeCompare(b.skillName));

  // bus-factor risk: skills held by EXACTLY one report.
  const busFactor = [...holdersBySkill.entries()]
    .filter(([, v]) => v.holders.size === 1)
    .map(([skillId, v]) => ({ skillId, skillName: v.name, holders: 1 }))
    .sort((a, b) => a.skillName.localeCompare(b.skillName));

  return TeamSkillMap.parse({ managerId: manager.id, members, busFactor, benchStrength });
}

/** A skill's org-wide supply/demand row, used by both `skillInventory` and the 5d wiring. */
export interface SkillSupplyDemand {
  skillId: string;
  skillName: string;
  category: SkillCategory;
  supply: number;
  demand: number;
  /** distinct employee ids holding the skill — exposed for talent-density / build-vs-buy. */
  holderCount: number;
}

/**
 * Compute per-skill org-wide supply (# distinct employees holding) and demand (# OPEN
 * JobOpenings requiring it, by case-insensitive canonicalName match against each open
 * role's `jdStructured.requiredSkills`). Shared by `skillInventory` (6c) and the Module
 * 5 (5d) analytics wiring so both read the SAME numbers from one query path.
 */
export async function computeSupplyDemand(tx: TxClient): Promise<SkillSupplyDemand[]> {
  const skills = await tx.skill.findMany({
    select: { id: true, canonicalName: true, category: true },
  });

  // supply: # employees per skill. The DB unique [employeeId, skillId] guarantees one
  // record per (employee, skill), so a row count per skillId equals distinct employees.
  const supplyGroups = await tx.skillRecord.groupBy({
    by: ["skillId"],
    _count: { _all: true },
  });
  const supplyBySkill = new Map<string, number>();
  for (const g of supplyGroups) supplyBySkill.set(g.skillId, g._count._all);

  // demand: count OPEN roles whose required-skill canonicalNames match each skill name.
  const openRoles = await tx.jobOpening.findMany({
    where: { status: "OPEN" },
    select: { jdStructured: true },
  });
  const demandByNorm = new Map<string, number>();
  for (const role of openRoles) {
    if (role.jdStructured == null) continue;
    const parsed = JDStructured.safeParse(role.jdStructured);
    if (!parsed.success) continue;
    // A role demands a skill at most ONCE even if its JD lists it twice.
    const namesThisRole = new Set(
      parsed.data.requiredSkills.map((s) => normaliseSkillName(s.canonicalName)),
    );
    for (const norm of namesThisRole) {
      demandByNorm.set(norm, (demandByNorm.get(norm) ?? 0) + 1);
    }
  }

  return skills
    .map((s) => {
      const supply = supplyBySkill.get(s.id) ?? 0;
      const demand = demandByNorm.get(normaliseSkillName(s.canonicalName)) ?? 0;
      return {
        skillId: s.id,
        skillName: s.canonicalName,
        category: category(s.category),
        supply,
        demand,
        holderCount: supply,
      };
    })
    .sort((a, b) => b.demand - a.demand || a.skillName.localeCompare(b.skillName));
}

/**
 * 6c — Org-wide skill inventory (HRBP / leadership view). Per skill: supply (#
 * employees holding), demand (# OPEN roles requiring it), and gap = demand - supply
 * (positive = under-supplied). `talentDensityIndex` is the share of in-demand skills
 * (demand > 0) the org meets internally (supply >= demand); null when no skill is in
 * demand (not derivable). This is a best-effort org-level density signal — a precise
 * "% of employees meeting their role's bar" requires per-employee role assignments
 * (documented limit in the README).
 */
export async function skillInventory(tx: TxClient): Promise<TSkillInventory> {
  const rows = await computeSupplyDemand(tx);

  const items = rows.map((r) => ({
    skillId: r.skillId,
    skillName: r.skillName,
    category: r.category,
    supply: r.supply,
    demand: r.demand,
    gap: r.demand - r.supply,
  }));

  // talentDensityIndex: of the skills the org actually demands, what fraction are met
  // internally (supply >= demand). null when nothing is demanded — not derivable.
  const demanded = rows.filter((r) => r.demand > 0);
  const talentDensityIndex =
    demanded.length === 0
      ? null
      : demanded.filter((r) => r.supply >= r.demand).length / demanded.length;

  return SkillInventory.parse({ items, talentDensityIndex });
}
