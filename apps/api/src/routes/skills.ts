import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AddEmployeeSkillRequest,
  ApiError,
  BuildVsBuyRequest,
  BuildVsBuyResponse,
  CreateSkillRequest,
  EmployeeSkillProfile,
  GrowthPathRequest,
  GrowthPathResponse,
  Skill,
  SkillCategory,
  SkillGapReport,
  SkillInventory,
  SkillRecordView,
  TeamSkillMap,
  VerifySkillRequest,
  WhoHasSkillResult,
  confidenceForSource,
  type Skill as TSkill,
  type SkillSource as TSkillSource,
} from "@peopleos/schemas";
import { Prisma } from "@prisma/client";
import type { Skill as PrismaSkill } from "@prisma/client";
import { withTenant } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { writeAudit } from "../lib/audit.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { aiClient } from "../lib/aiClient.js";
import { buildOrgContext } from "../lib/orgContext.js";
import {
  computeSupplyDemand,
  employeeSkillProfile,
  skillGap,
  skillInventory,
  teamSkillMap,
  whoHasSkill,
} from "../lib/skillGraph.js";

/**
 * Module 6 — Employee Skill Graph routes. Mounted under /api/v1, tenant-scoped via
 * requireTenant + withTenant(orgId) (RLS isolates all skill data per org).
 *
 *   GET   /skills                          list the org's skill catalog
 *   POST  /skills                          create a catalog skill        (ADMIN/HRBP)
 *   GET   /employees/:id/skills            EmployeeSkillProfile           (6a)
 *   POST  /employees/:id/skills            self-report a skill (SELF_REPORTED, 0.5)
 *   PATCH /skill-records/:id/verify        manager verification           (6d)
 *   GET   /skills/who-has/:skillId         WhoHasSkillResult     (query pattern 1)
 *   GET   /employees/:id/skill-gap         gap + AI growth path  (6a, query pattern 3)
 *   GET   /skills/team-map?managerId=      TeamSkillMap                   (6b)
 *   GET   /skills/inventory                SkillInventory                 (6c)
 *   GET   /skills/build-vs-buy?skillId=    BuildVsBuyResponse             (6c)
 *
 * CONFIDENCE IS NEVER CLIENT-SUPPLIED. The contract carries no confidence field on any
 * write request; every SkillRecord's `confidenceScore` is derived server-side from its
 * provenance via `confidenceForSource` (self 0.5 / manager 0.8 / assessment 0.9 /
 * resume 0.6 / project 0.7 — spec Layer 3A). Assessment integration (Codility/Vervoe/
 * HackerRank → ASSESSMENT_VERIFIED 0.9) is a documented webhook stub; see the README.
 */

const SkillIdParam = z.object({ skillId: z.string().uuid() });
const EmployeeIdParam = z.object({ id: z.string().uuid() });
const SkillRecordIdParam = z.object({ id: z.string().uuid() });
const SkillListResponse = z.object({ items: z.array(Skill) });
const TeamMapQuery = z.object({ managerId: z.string().uuid() });
const BuildVsBuyQuery = z.object({ skillId: z.string().uuid() });
const SkillGapQuery = z.object({ targetRoleId: z.string().uuid() });

/** The combined gap + AI growth-path payload returned by GET /employees/:id/skill-gap. */
const SkillGapWithPath = z.object({ gap: SkillGapReport, growthPath: GrowthPathResponse });

/** Roles permitted to manage the skill catalog (HRBP / leadership). */
const CATALOG_ADMIN_ROLES = new Set(["ADMIN", "HRBP"]);
/** Roles permitted to verify a claimed skill (spec 6d manager verification). */
const VERIFY_ROLES = new Set(["ADMIN", "HRBP", "MANAGER"]);
/** Roles permitted the org-wide leadership inventory + build-vs-buy view (6c). */
const INVENTORY_ROLES = new Set(["ADMIN", "HRBP", "MANAGER"]);

function serializeSkill(row: PrismaSkill): TSkill {
  return Skill.parse({
    id: row.id,
    orgId: row.orgId,
    canonicalName: row.canonicalName,
    aliases: row.aliases,
    category: SkillCategory.parse(row.category),
    escoUri: row.escoUri,
    parentSkillId: row.parentSkillId,
  });
}

const skillRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Skill catalog ─────────────────────────────────────────────────────────────
  r.get(
    "/skills",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "List the org's skill catalog.",
        response: { 200: SkillListResponse, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      return withTenant(orgId, async (tx) => {
        const rows = await tx.skill.findMany({ orderBy: { canonicalName: "asc" } });
        return { items: rows.map(serializeSkill) };
      });
    },
  );

  r.post(
    "/skills",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Create a catalog skill (ADMIN/HRBP).",
        body: CreateSkillRequest,
        response: { 201: Skill, 400: ApiError, 401: ApiError, 403: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, userId, role } = tenant(request);
      if (!CATALOG_ADMIN_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may create catalog skills.");
      }
      const body = request.body;

      const created = await withTenant(orgId, async (tx) => {
        // If a parent skill is named, confirm it exists in this tenant first so a
        // dangling parent is a clean 400 rather than an opaque FK error.
        if (body.parentSkillId) {
          const parent = await tx.skill.findUnique({
            where: { id: body.parentSkillId },
            select: { id: true },
          });
          if (!parent) throw badRequest(`Parent skill ${body.parentSkillId} not found`);
        }

        const skill = await tx.skill.create({
          data: {
            orgId,
            canonicalName: body.canonicalName,
            aliases: body.aliases,
            category: body.category,
            parentSkillId: body.parentSkillId ?? null,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "skill.create",
          entityType: "skill",
          entityId: skill.id,
          payload: { canonicalName: skill.canonicalName, category: skill.category },
          ip: request.ip,
        });
        return skill;
      });

      return reply.code(201).send(serializeSkill(created));
    },
  );

  // ── 6a — Employee skill profile ────────────────────────────────────────────────
  r.get(
    "/employees/:id/skills",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Get an employee's skill profile (Module 6a).",
        params: EmployeeIdParam,
        response: { 200: EmployeeSkillProfile, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;
      return withTenant(orgId, (tx) => employeeSkillProfile(tx, id));
    },
  );

  r.post(
    "/employees/:id/skills",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Self-report an employee skill (creates a SELF_REPORTED record, confidence 0.5).",
        description:
          "Creates an (Employee)-[HAS_SKILL]->(Skill) record with source SELF_REPORTED and confidenceScore derived SERVER-SIDE from that source (0.5) — confidence is NEVER taken from the client. The record starts unverified (verifiedById/verifiedAt null); a manager can later confirm it via PATCH /skill-records/:id/verify (spec 6d re-verification flow).",
        params: EmployeeIdParam,
        body: AddEmployeeSkillRequest,
        response: { 201: EmployeeSkillProfile, 400: ApiError, 401: ApiError, 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, userId } = tenant(request);
      const { id: employeeId } = request.params;
      const body = request.body;

      const profile = await withTenant(orgId, async (tx) => {
        // Both ends of the HAS_SKILL edge must exist in this tenant (RLS-scoped) so a
        // missing/cross-org id is a clean 404 rather than an opaque FK violation.
        const [employee, skill] = await Promise.all([
          tx.employee.findUnique({ where: { id: employeeId }, select: { id: true } }),
          tx.skill.findUnique({ where: { id: body.skillId }, select: { id: true } }),
        ]);
        if (!employee) throw notFound(`Employee ${employeeId} not found`);
        if (!skill) throw notFound(`Skill ${body.skillId} not found`);

        // Confidence is DERIVED from the source, never client-supplied (spec Layer 3A).
        const source = "SELF_REPORTED" as const;
        const record = await tx.skillRecord.create({
          data: {
            orgId,
            employeeId,
            skillId: body.skillId,
            proficiency: body.proficiency,
            source,
            confidenceScore: confidenceForSource(source),
            // Self-reported claims are unverified until a manager/assessment confirms.
            verifiedById: null,
            verifiedAt: null,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "skillRecord.selfReport",
          entityType: "skill_record",
          entityId: record.id,
          payload: { employeeId, skillId: body.skillId, source, proficiency: body.proficiency },
          ip: request.ip,
        });
        // Return the refreshed profile so the UI re-renders with the new record.
        return employeeSkillProfile(tx, employeeId);
      });

      return reply.code(201).send(profile);
    },
  );

  // ── 6d — Manager / assessment verification ──────────────────────────────────────
  r.patch(
    "/skill-records/:id/verify",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Verify a claimed skill (→ MANAGER_VERIFIED, confidence 0.8) — ADMIN/HRBP/MANAGER.",
        description:
          "Spec 6d manager verification: confirms a claimed skill, setting source MANAGER_VERIFIED, confidenceScore derived SERVER-SIDE from that source (0.8), verifiedById = the caller, and verifiedAt = now. May optionally adjust proficiency. Confidence is never client-supplied. Assessment integration (Codility/Vervoe/HackerRank → ASSESSMENT_VERIFIED 0.9) arrives via a separate documented webhook stub, not this endpoint.",
        params: SkillRecordIdParam,
        body: VerifySkillRequest,
        response: { 200: SkillRecordView, 401: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      if (!VERIFY_ROLES.has(role)) {
        throw forbidden("Only ADMIN, HRBP, or MANAGER roles may verify a skill.");
      }
      const { id } = request.params;
      const body = request.body;

      const updated = await withTenant(orgId, async (tx) => {
        const existing = await tx.skillRecord.findUnique({
          where: { id },
          select: { id: true, source: true },
        });
        if (!existing) throw notFound(`Skill record ${id} not found`);

        const source = "MANAGER_VERIFIED" as const;
        // Never let a manager verify DOWNGRADE a higher-trust provenance (e.g. an
        // assessment-verified 0.9 skill): confidence must never go DOWN on verify.
        if (confidenceForSource(source) < confidenceForSource(existing.source as TSkillSource)) {
          throw badRequest(
            "Cannot lower a higher-trust skill verification (e.g. assessment-verified) via manager verify.",
          );
        }
        const record = await tx.skillRecord.update({
          where: { id },
          data: {
            source,
            // Confidence ALWAYS derived from the (new) source server-side.
            confidenceScore: confidenceForSource(source),
            verifiedById: userId,
            verifiedAt: new Date(),
            // Optional proficiency correction (a manager may re-grade on confirm).
            ...(body.proficiency ? { proficiency: body.proficiency } : {}),
          },
          include: { skill: { select: { canonicalName: true, category: true } } },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "skillRecord.verify",
          entityType: "skill_record",
          entityId: record.id,
          payload: { source, ...(body.proficiency ? { proficiency: body.proficiency } : {}) },
          ip: request.ip,
        });
        return record;
      });

      // Return the joined SkillRecordView (the verified record + its skill display fields).
      return SkillRecordView.parse({
        id: updated.id,
        skillId: updated.skillId,
        skillName: updated.skill.canonicalName,
        category: updated.skill.category,
        proficiency: updated.proficiency,
        confidenceScore: updated.confidenceScore,
        source: updated.source,
        verifiedAt: updated.verifiedAt ? updated.verifiedAt.toISOString() : null,
      });
    },
  );

  // ── Query pattern 1 — who has skill X ────────────────────────────────────────────
  r.get(
    "/skills/who-has/:skillId",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Who in the org has this skill? (spec query pattern 1).",
        params: SkillIdParam,
        response: { 200: WhoHasSkillResult, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { skillId } = request.params;
      return withTenant(orgId, (tx) => whoHasSkill(tx, skillId));
    },
  );

  // ── 6a / query pattern 3 — skill gap + AI growth path ────────────────────────────
  r.get(
    "/employees/:id/skill-gap",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Skill gap to a target role + AI growth path (Module 6a, query pattern 3).",
        description:
          "Computes the employee's skill gap vs the target role's required skills (from the role's structured JD), then asks the AI service (Claude claude-sonnet-4-6) for a grounded growth path: how many skills away, which to add, and suggested training — grounded ONLY in the employee's skills + the org's skill catalog (prompt standard #2). Returns { gap, growthPath }. 502 if the AI service is unavailable.",
        params: EmployeeIdParam,
        querystring: SkillGapQuery,
        response: {
          200: SkillGapWithPath,
          400: ApiError,
          401: ApiError,
          404: ApiError,
          502: ApiError,
        },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      const { id: employeeId } = request.params;
      const { targetRoleId } = request.query;

      // Compute the gap + gather the AI inputs (employee skills, catalog, org context)
      // all inside ONE tenant transaction so RLS scopes every read.
      const { gap, employeeSkills, skillCatalog, org } = await withTenant(orgId, async (tx) => {
        const computedGap = await skillGap(tx, employeeId, targetRoleId);
        const profile = await employeeSkillProfile(tx, employeeId);
        const catalog = await tx.skill.findMany({
          select: { canonicalName: true },
          orderBy: { canonicalName: "asc" },
        });
        const orgRow = await tx.organisation.findUnique({ where: { id: orgId } });
        return {
          gap: computedGap,
          employeeSkills: profile.skills.map((s) => ({ name: s.skillName, proficiency: s.proficiency })),
          skillCatalog: catalog.map((c) => c.canonicalName),
          org: orgRow,
        };
      });

      const growthPath = await aiClient.growthPath(
        GrowthPathRequest.parse({
          orgId,
          employeeSkills,
          targetRoleTitle: gap.targetRoleTitle,
          targetRequiredSkills: gap.requiredSkills,
          skillCatalog,
          orgContext: buildOrgContext(org, role),
        }),
      );

      return { gap, growthPath };
    },
  );

  // ── 6b — team skill map ──────────────────────────────────────────────────────────
  r.get(
    "/skills/team-map",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Team skill map over a manager's direct reports (Module 6b).",
        description:
          "Per-member skills, bus-factor risks (skills held by exactly ONE report), and bench strength (holder count per skill) over the manager's direct reports (Employee.managerId).",
        querystring: TeamMapQuery,
        response: { 200: TeamSkillMap, 400: ApiError, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { managerId } = request.query;
      return withTenant(orgId, (tx) => teamSkillMap(tx, managerId));
    },
  );

  // ── 6c — org-wide skill inventory ────────────────────────────────────────────────
  r.get(
    "/skills/inventory",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Org-wide skill supply vs demand inventory (Module 6c) — ADMIN/HRBP/MANAGER.",
        description:
          "Per skill: supply (# employees holding), demand (# OPEN roles requiring it), and gap = demand - supply. Includes a best-effort talentDensityIndex (share of in-demand skills met internally; null if nothing is demanded). Leadership view.",
        response: { 200: SkillInventory, 401: ApiError, 403: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      if (!INVENTORY_ROLES.has(role)) {
        throw forbidden("Only ADMIN, HRBP, or MANAGER roles may view the org skill inventory.");
      }
      return withTenant(orgId, (tx) => skillInventory(tx));
    },
  );

  // ── 6c — build vs buy recommender ────────────────────────────────────────────────
  r.get(
    "/skills/build-vs-buy",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["skills"],
        summary: "Build-vs-Buy recommendation for a skill gap (Module 6c) — ADMIN/HRBP/MANAGER.",
        description:
          "Computes the org-level signal for one skill (current supply, open-role demand, and how many current employees are trainable into the gap — i.e. hold an adjacent taxonomy skill but not this one), then asks the AI service (Claude claude-sonnet-4-6) to recommend BUILD / BUY / HYBRID with a rationale grounded strictly in those numbers. Advisory only. 502 if the AI service is unavailable.",
        querystring: BuildVsBuyQuery,
        response: { 200: BuildVsBuyResponse, 400: ApiError, 401: ApiError, 403: ApiError, 404: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      if (!INVENTORY_ROLES.has(role)) {
        throw forbidden("Only ADMIN, HRBP, or MANAGER roles may use the build-vs-buy recommender.");
      }
      const { skillId } = request.query;

      const { skillName, supply, demand, trainable, org } = await withTenant(orgId, async (tx) => {
        const skill = await tx.skill.findUnique({
          where: { id: skillId },
          select: { id: true, canonicalName: true, parentSkillId: true },
        });
        if (!skill) throw notFound(`Skill ${skillId} not found`);

        // supply + demand come from the SAME shared computation the inventory uses.
        const rows = await computeSupplyDemand(tx);
        const row = rows.find((s) => s.skillId === skillId);
        const skillSupply = row?.supply ?? 0;
        const skillDemand = row?.demand ?? 0;

        // trainableInternally: employees 1-2 skills away — approximated as those who
        // hold an ADJACENT taxonomy skill (this skill's parent, children, or siblings)
        // but NOT the skill itself. (Prod uses the Skill RELATED_TO graph; the
        // relational model carries the parent/child taxonomy, so we use that adjacency.)
        const adjacencyConditions: Prisma.SkillWhereInput[] = [{ parentSkillId: skillId }];
        if (skill.parentSkillId) {
          adjacencyConditions.push({ id: skill.parentSkillId });
          adjacencyConditions.push({ parentSkillId: skill.parentSkillId });
        }
        const adjacent = await tx.skill.findMany({
          where: { id: { not: skillId }, OR: adjacencyConditions },
          select: { id: true },
        });
        const adjacentIds = adjacent.map((s) => s.id);

        let trainableCount = 0;
        if (adjacentIds.length > 0) {
          // Employees holding ANY adjacent skill, MINUS those who already hold this one.
          const holdersOfThis = await tx.skillRecord.findMany({
            where: { skillId },
            select: { employeeId: true },
          });
          const haveThis = new Set(holdersOfThis.map((h) => h.employeeId));
          const adjacentHolders = await tx.skillRecord.findMany({
            where: { skillId: { in: adjacentIds } },
            select: { employeeId: true },
            distinct: ["employeeId"],
          });
          trainableCount = adjacentHolders.filter((h) => !haveThis.has(h.employeeId)).length;
        }

        const orgRow = await tx.organisation.findUnique({ where: { id: orgId } });
        return {
          skillName: skill.canonicalName,
          supply: skillSupply,
          demand: skillDemand,
          trainable: trainableCount,
          org: orgRow,
        };
      });

      return aiClient.buildVsBuy(
        BuildVsBuyRequest.parse({
          orgId,
          skill: skillName,
          currentSupply: supply,
          demand,
          trainableInternally: trainable,
          orgContext: buildOrgContext(org, role),
        }),
      );
    },
  );
};

export default skillRoutes;
