import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  AttritionBiasAuditRequest,
  AttritionBiasAuditResponse,
  AttritionEmployeeContext,
  AttritionEmployeeView,
  AttritionFeatures,
  AttritionOptOutRequest,
  AttritionSummary,
  DisparityRequest,
  DriverContribution,
  ExplainAttritionRequest,
  ManagerAttritionView,
  RunScoringResponse,
  ScoreAttritionRequest,
  type AttritionHeatCell as TAttritionHeatCell,
  type DisparityRecord as TDisparityRecord,
  type RiskTier as TRiskTier,
} from "@peopleos/schemas";
import { Prisma } from "@prisma/client";
import { withTenant } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { aiClient } from "../lib/aiClient.js";
import { writeAudit } from "../lib/audit.js";
import { forbidden, notFound } from "../lib/errors.js";
import { buildOrgContext } from "../lib/orgContext.js";
import { computeFeatures, type FeaturePeer } from "../lib/attritionFeatures.js";
import {
  countByTier,
  DEFAULT_SELECTION_TIERS,
  isRegrettable,
  loadLatestScores,
  riskTierToRankingTier,
} from "../lib/attritionScores.js";

/**
 * Module 7 — Attrition Prediction Engine routes. Mounted under /api/v1, tenant-scoped
 * via requireTenant + withTenant(orgId) (RLS isolates all attrition data per org).
 *
 *   POST  /attrition/score                       run scoring over the org    (ADMIN/HRBP)
 *   GET   /attrition/summary                     tier counts + heatmap   (ADMIN/HRBP/MANAGER)
 *   GET   /employees/:id/attrition               full / manager / 403 view by ROLE
 *   PATCH /employees/:id/attrition-opt-out       opt in/out of profiling
 *   POST  /attrition/bias-audit                  tier-distribution disparity (ADMIN/HRBP)
 *
 * GOVERNANCE (spec ethics) — enforced at the route boundary:
 *   - The score is ADVISORY ONLY. No endpoint takes an automated HR action.
 *   - Opted-out employees (Employee.attritionOptOut) are EXCLUDED from scoring; on
 *     opt-out their existing AttritionScore rows are DELETED.
 *   - A MANAGER sees the TIER + RECOMMENDATION ONLY (ManagerAttritionView) — never the
 *     raw score, SHAP values, or feature values — and ONLY for their OWN direct reports.
 *   - The score is NEVER shown to the employee: an EMPLOYEE role gets a 403.
 *   - The model uses ONLY tenure/perf/team/skill features — never a protected attribute
 *     (enforced in lib/attritionFeatures.ts, by construction).
 *   - The monthly bias audit reuses the Module 1 disparity engine; demographics arrive
 *     per-request and are NEVER persisted.
 */

const EmployeeIdParam = z.object({ id: z.string().uuid() });

/** Roles permitted to run scoring / view the full score / run a bias audit (people-ops). */
const ATTRITION_ADMIN_ROLES = new Set(["ADMIN", "HRBP"]);
/**
 * Roles permitted the org-wide aggregate summary. LEADERSHIP ONLY: the heatmap's
 * small (department × level × tier) cells could let a manager re-identify an
 * individual's tier and exposes departments they don't own, so managers are NOT
 * granted the org aggregate — they see only tier + recommendation for their own
 * reports via GET /employees/:id/attrition.
 */
const SUMMARY_VIEW_ROLES = new Set(["ADMIN", "HRBP"]);

/** Map a stored AttritionScore.riskTier string → the typed RiskTier (parse-guarded). */
const RiskTierEnum = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

const attritionRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Run scoring over the whole org (ADMIN/HRBP) ─────────────────────────────
  r.post(
    "/attrition/score",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["attrition"],
        summary: "Run the attrition risk scorer over the org (Module 7) — ADMIN/HRBP.",
        description:
          "Loads ACTIVE, NOT-opted-out employees, computes each one's available AttritionFeatures (tenure/perf/team/skill signals — never a protected attribute), calls the AI scorer in one batch, and UPSERTs one current AttritionScore per employee. The score is ADVISORY ONLY. Opted-out employees are skipped entirely. Returns RunScoringResponse { scoredCount, skippedOptedOut, byTier, modelVersion, scoredAt }. 502 if the AI service is unavailable.",
        response: { 200: RunScoringResponse, 401: ApiError, 403: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      if (!ATTRITION_ADMIN_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may run attrition scoring.");
      }
      const now = new Date();

      // ── 1) Load the population + compute features (all inside the tenant tx) ──
      const { employeeFeatures, skippedOptedOut } = await withTenant(orgId, async (tx) => {
        // Opted-out employees are excluded from scoring ENTIRELY (spec ethics).
        const optedOut = await tx.employee.count({
          where: { status: "ACTIVE", attritionOptOut: true },
        });

        const employees = await tx.employee.findMany({
          where: { status: "ACTIVE", attritionOptOut: false },
          select: {
            id: true,
            department: true,
            managerId: true,
            hireDate: true,
            lastReviewDate: true,
            lastReviewRating: true,
            lastPromotionDate: true,
          },
        });

        // Pre-load the peer set ONCE for the team-attrition feature, to avoid an N+1.
        // We need both the active team (denominator) and recently TERMINATED teammates
        // (numerator), so we load ACTIVE/ON_LEAVE/TERMINATED with their team keys.
        const peers = await tx.employee.findMany({
          where: { status: { in: ["ACTIVE", "ON_LEAVE", "TERMINATED"] } },
          select: { id: true, status: true, department: true, managerId: true },
        });

        // Index peers by manager and by department so each employee's team is O(1).
        const byManager = new Map<string, FeaturePeer[]>();
        const byDepartment = new Map<string, FeaturePeer[]>();
        for (const p of peers) {
          // The frozen Employee model has no termination-date column; pass null so the
          // feature builder counts a TERMINATED teammate toward the 90d window (the
          // conservative choice for a retention-risk signal — documented).
          const peer: FeaturePeer = { id: p.id, status: p.status, terminatedAt: null };
          if (p.managerId) {
            const list = byManager.get(p.managerId) ?? [];
            list.push(peer);
            byManager.set(p.managerId, list);
          }
          if (p.department) {
            const list = byDepartment.get(p.department) ?? [];
            list.push(peer);
            byDepartment.set(p.department, list);
          }
        }

        const featuresList: Array<{ employeeId: string; features: z.infer<typeof AttritionFeatures> }> = [];
        for (const e of employees) {
          // Team = same manager when present, else same department, else empty.
          const team = e.managerId
            ? (byManager.get(e.managerId) ?? [])
            : e.department
              ? (byDepartment.get(e.department) ?? [])
              : [];
          const features = await computeFeatures(tx, e, team, now);
          featuresList.push({ employeeId: e.id, features });
        }

        return { employeeFeatures: featuresList, skippedOptedOut: optedOut };
      });

      // No eligible employees → nothing to score. Return an empty, well-formed result
      // rather than calling the AI scorer with an empty batch (the contract requires ≥1).
      if (employeeFeatures.length === 0) {
        return RunScoringResponse.parse({
          scoredCount: 0,
          skippedOptedOut,
          byTier: countByTier([]),
          modelVersion: "none",
          scoredAt: now.toISOString(),
        });
      }

      // ── 2) Call the AI scorer (batch) — no LLM, no PII, advisory only ────────
      const scored = await aiClient.scoreAttrition(
        ScoreAttritionRequest.parse({ orgId, employees: employeeFeatures }),
      );

      // ── 3) UPSERT one current score per employee + audit (tenant-scoped) ─────
      await withTenant(orgId, async (tx) => {
        for (const s of scored.scores) {
          const data = {
            orgId,
            riskScore: s.riskScore,
            riskTier: s.riskTier,
            topDrivers: s.topDrivers as unknown as Prisma.InputJsonValue,
            shapValues: s.shapValues as unknown as Prisma.InputJsonValue,
            modelVersion: scored.modelVersion,
            scoredAt: now,
          };
          // One CURRENT score per employee: delete prior rows, then create the new one.
          // (No natural unique key on employeeId in the schema, so this keeps "one
          // current" semantics deterministically within the tenant transaction.)
          await tx.attritionScore.deleteMany({ where: { employeeId: s.employeeId } });
          await tx.attritionScore.create({ data: { ...data, employeeId: s.employeeId } });
        }

        const byTier = countByTier(scored.scores);
        await writeAudit(tx, {
          actorId: userId,
          action: "attrition.score",
          entityType: "organisation",
          entityId: orgId,
          // Governance metadata only — counts + model version, never per-employee scores.
          payload: {
            scoredCount: scored.scores.length,
            skippedOptedOut,
            modelVersion: scored.modelVersion,
            byTier: Object.fromEntries(byTier.map((b) => [b.tier, b.count])),
          },
          ip: request.ip,
        });
      });

      return RunScoringResponse.parse({
        scoredCount: scored.scores.length,
        skippedOptedOut,
        byTier: countByTier(scored.scores),
        modelVersion: scored.modelVersion,
        scoredAt: now.toISOString(),
      });
    },
  );

  // ── Aggregate summary (ADMIN/HRBP — leadership only) ────────────────────────
  r.get(
    "/attrition/summary",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["attrition"],
        summary: "Attrition tier distribution + heatmap (Module 7) — ADMIN/HRBP.",
        description:
          "Aggregates the LATEST attrition scores into per-tier counts and a department/level heatmap, plus optedOutCount and regrettableCount (a strong performer — perf rating ≥ 4 — at CRITICAL/HIGH risk). This is an AGGREGATE leadership view; it never exposes an individual's raw score. Tenant-scoped via RLS.",
        response: { 200: AttritionSummary, 401: ApiError, 403: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      if (!SUMMARY_VIEW_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may view the org attrition summary.");
      }

      return withTenant(orgId, async (tx) => {
        const latest = await loadLatestScores(tx);
        // Count opt-outs over the SAME population scoring uses (ACTIVE), so this agrees
        // with RunScoringResponse.skippedOptedOut.
        const optedOutCount = await tx.employee.count({
          where: { status: "ACTIVE", attritionOptOut: true },
        });

        // Join each scored employee with their department/level/perf for the heatmap
        // and the regrettable-loss count.
        const ids = [...latest.keys()];
        const employees = ids.length
          ? await tx.employee.findMany({
              where: { id: { in: ids } },
              select: { id: true, department: true, level: true, lastReviewRating: true },
            })
          : [];
        const empById = new Map(employees.map((e) => [e.id, e]));

        const scores = [...latest.values()];
        const byTier = countByTier(scores);

        // Heatmap: count per (DEPARTMENT|LEVEL, group, tier). TEAM is not surfaced here
        // (manager grouping is the team dimension and is omitted from the org summary).
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

        const heatmap = [...cellCounts.values()].sort(
          (a, b) =>
            a.dimension.localeCompare(b.dimension) ||
            a.group.localeCompare(b.group) ||
            a.tier.localeCompare(b.tier),
        );

        return AttritionSummary.parse({
          byTier,
          heatmap,
          regrettableCount,
          scoredCount: scores.length,
          optedOutCount,
          generatedAt: new Date().toISOString(),
        });
      });
    },
  );

  // ── Per-employee view — ROLE-GATED (full / manager / 403) ───────────────────
  r.get(
    "/employees/:id/attrition",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["attrition"],
        summary: "An employee's attrition view — role-gated (Module 7).",
        description:
          "ADMIN/HRBP get the FULL AttritionEmployeeView (riskScore + topDrivers + shapValues + AI narrative + recommendedActions). A MANAGER gets the ManagerAttritionView (TIER + recommendedActions ONLY — never the raw score, SHAP, or feature values) and ONLY for their OWN direct reports. An EMPLOYEE always gets a 403 — the score is NEVER shown to the employee. The AI explanation is grounded ONLY in the top drivers + a NON-PII employee context. 502 if the AI service is unavailable.",
        params: EmployeeIdParam,
        response: {
          200: z.union([AttritionEmployeeView, ManagerAttritionView]),
          401: ApiError,
          403: ApiError,
          404: ApiError,
          502: ApiError,
        },
      },
    },
    async (request, reply) => {
      const { orgId, userId, role, source } = tenant(request);
      const { id: employeeId } = request.params;

      // The score is NEVER shown to the employee (spec ethics) — block early.
      if (role === "EMPLOYEE") {
        throw forbidden("Attrition scores are never shown to the employee.");
      }
      const isAdmin = ATTRITION_ADMIN_ROLES.has(role);
      const isManager = role === "MANAGER";
      if (!isAdmin && !isManager) {
        throw forbidden("Not permitted to view attrition for this employee.");
      }

      // ── Load the employee + their latest score + (for the explanation) context ─
      const loaded = await withTenant(orgId, async (tx) => {
        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
          select: {
            id: true,
            name: true,
            managerId: true,
            roleTitle: true,
            department: true,
            level: true,
            hireDate: true,
            attritionOptOut: true,
          },
        });
        if (!employee) throw notFound(`Employee ${employeeId} not found`);

        // A manager may only see their OWN direct reports (spec ethics). The acting
        // MANAGER is an Employee; their reports point to that employee's id, so we
        // resolve the manager's own Employee record from the authenticated user id and
        // require it to equal the target's managerId.
        if (isManager) {
          // Resolve the acting manager's Employee from the SESSION principal via the
          // trusted identity chain: in prod the principal is a Clerk id → map it to the
          // internal User.id first; in dev the principal IS the internal User.id.
          // Employee.userId links the person to that user.
          let internalUserId = userId;
          if (source === "clerk") {
            const u = await tx.user.findFirst({
              where: { clerkUserId: userId },
              select: { id: true },
            });
            if (!u) {
              throw forbidden("A manager may only view attrition for their own direct reports.");
            }
            internalUserId = u.id;
          }
          const me = await tx.employee.findFirst({
            where: { userId: internalUserId },
            select: { id: true },
          });
          if (!me || employee.managerId !== me.id) {
            throw forbidden("A manager may only view attrition for their own direct reports.");
          }
        }

        const score = await tx.attritionScore.findFirst({
          where: { employeeId },
          orderBy: { scoredAt: "desc" },
        });

        const org = await tx.organisation.findUnique({ where: { id: orgId } });
        return { employee, score, org };
      });

      // An opted-out employee has no scores (deleted on opt-out) — surface a clean 404.
      // For a MANAGER the opted-out and never-scored cases are INDISTINGUISHABLE, so a
      // report's opt-out choice (a privacy decision) is never inferable by their manager.
      if (!loaded.score) {
        const generic = `No attrition score for employee ${employeeId}`;
        throw notFound(
          isManager
            ? generic
            : loaded.employee.attritionOptOut
              ? `Employee ${employeeId} has opted out of attrition profiling`
              : `${generic} (run scoring first)`,
        );
      }

      const riskTier = RiskTierEnum.parse(loaded.score.riskTier);
      const topDrivers = z.array(DriverContribution).parse(loaded.score.topDrivers);

      // ── AI explanation (grounded ONLY in drivers + NON-PII context) ──────────
      const employeeContext = AttritionEmployeeContext.parse({
        tenureDays: loaded.employee.hireDate
          ? Math.max(0, Math.floor((Date.now() - loaded.employee.hireDate.getTime()) / 86_400_000))
          : 0,
        roleTitle: loaded.employee.roleTitle,
        department: loaded.employee.department,
        level: loaded.employee.level,
      });
      const explanation = await aiClient.explainAttrition(
        ExplainAttritionRequest.parse({
          orgId,
          riskTier,
          topDrivers,
          employeeContext,
          orgContext: buildOrgContext(loaded.org, role),
        }),
      );

      // ── MANAGER: tier + recommendation ONLY (strip score/SHAP/features) ──────
      if (isManager) {
        return reply.send(
          ManagerAttritionView.parse({
            employeeId: loaded.employee.id,
            employeeName: loaded.employee.name,
            riskTier,
            recommendedActions: explanation.recommendedActions,
            scoredAt: loaded.score.scoredAt.toISOString(),
          }),
        );
      }

      // ── ADMIN/HRBP: the FULL view ────────────────────────────────────────────
      const shapValues = z.record(z.number()).parse(loaded.score.shapValues);
      return reply.send(
        AttritionEmployeeView.parse({
          employeeId: loaded.employee.id,
          employeeName: loaded.employee.name,
          riskScore: loaded.score.riskScore,
          riskTier,
          topDrivers,
          shapValues,
          narrative: explanation.narrative,
          recommendedActions: explanation.recommendedActions,
          scoredAt: loaded.score.scoredAt.toISOString(),
        }),
      );
    },
  );

  // ── Opt-out (employee's own / ADMIN/HRBP anyone's) ──────────────────────────
  r.patch(
    "/employees/:id/attrition-opt-out",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["attrition"],
        summary: "Opt an employee in/out of attrition profiling (Module 7 — right to not be profiled).",
        description:
          "Sets Employee.attritionOptOut. An EMPLOYEE may set their OWN opt-out; ADMIN/HRBP may set anyone's. On opt-out (true), the employee's existing AttritionScore rows are DELETED so they are excluded from all views and future scoring. Audited.",
        params: EmployeeIdParam,
        body: AttritionOptOutRequest,
        response: { 200: AttritionOptOutRequest, 401: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id: employeeId } = request.params;
      const { optOut } = request.body;
      const isAdmin = ATTRITION_ADMIN_ROLES.has(role);

      return withTenant(orgId, async (tx) => {
        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
          select: { id: true, userId: true },
        });
        if (!employee) throw notFound(`Employee ${employeeId} not found`);

        // RBAC: an employee may only set their OWN opt-out; ADMIN/HRBP may set anyone's.
        if (!isAdmin && employee.userId !== userId) {
          throw forbidden("You may only change your own attrition opt-out.");
        }

        await tx.employee.update({
          where: { id: employeeId },
          data: { attritionOptOut: optOut },
        });

        // On opt-out, purge the employee's scores so they vanish from every view.
        let deletedScores = 0;
        if (optOut) {
          const result = await tx.attritionScore.deleteMany({ where: { employeeId } });
          deletedScores = result.count;
        }

        await writeAudit(tx, {
          actorId: userId,
          action: optOut ? "attrition.optOut" : "attrition.optIn",
          entityType: "employee",
          entityId: employeeId,
          payload: { optOut, ...(optOut ? { deletedScores } : {}) },
          ip: request.ip,
        });

        return { optOut };
      });
    },
  );

  // ── Monthly bias audit (ADMIN/HRBP) — reuses the Module 1 disparity engine ───
  r.post(
    "/attrition/bias-audit",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["attrition"],
        summary: "Tier-distribution disparity audit across demographic groups (Module 7) — ADMIN/HRBP.",
        description:
          "Joins the LATEST attrition scores with a per-request demographic mapping (employeeId → group; NEVER stored) and runs the Module 1 EEOC 4/5ths disparity engine over the tier distribution — by default CRITICAL + HIGH count as the 'flagged' outcome. Returns { report, unmatched } (employees in the mapping with no current score are excluded). PeopleOS never persists protected attributes. 502 if the AI service is unavailable.",
        body: AttritionBiasAuditRequest,
        response: {
          200: AttritionBiasAuditResponse,
          400: ApiError,
          401: ApiError,
          403: ApiError,
          502: ApiError,
        },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      if (!ATTRITION_ADMIN_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may run an attrition bias audit.");
      }
      const { demographics, selectionTiers } = request.body;

      // ── Load the latest scores + write the audit entry (tenant-scoped) ───────
      const latest = await withTenant(orgId, async (tx) => {
        const scores = await loadLatestScores(tx);
        await writeAudit(tx, {
          actorId: userId,
          action: "attrition.bias_audit",
          entityType: "organisation",
          entityId: orgId,
          // Governance metadata only — NO per-employee group assignments are stored
          // (PeopleOS never persists protected attributes). Counts + run params only.
          payload: {
            demographicGroups: [...new Set(demographics.map((d) => d.group))].length,
            mappedEmployees: demographics.length,
            ...(selectionTiers ? { selectionTiers } : {}),
          },
          ip: request.ip,
        });
        return scores;
      });

      // ── Join scores ⋈ demographics by employeeId (in memory; never stored) ───
      const records: TDisparityRecord[] = [];
      const unmatched: string[] = [];
      for (const { employeeId, group } of demographics) {
        const score = latest.get(employeeId);
        if (!score) {
          unmatched.push(employeeId);
          continue;
        }
        // Map the RiskTier onto the disparity engine's RankingTier (CRITICAL→A …).
        records.push({ group, score: score.riskScore, tier: riskTierToRankingTier(score.riskTier) });
      }

      // No matched records → return an empty report rather than calling the AI with an
      // empty set (DisparityRequest requires ≥ 1 record).
      if (records.length === 0) {
        return AttritionBiasAuditResponse.parse({ report: emptyReport(), unmatched });
      }

      // The flagged outcome is CRITICAL + HIGH by default; map any caller override too.
      const tiers = (selectionTiers ?? DEFAULT_SELECTION_TIERS).map(riskTierToRankingTier);
      const report = await aiClient.disparity(
        DisparityRequest.parse({ records, selectionTiers: tiers }),
      );

      return AttritionBiasAuditResponse.parse({ report, unmatched });
    },
  );
};

/** A well-formed empty DisparityReport for the no-matched-employees case. */
function emptyReport(): z.infer<typeof AttritionBiasAuditResponse>["report"] {
  return {
    groups: [],
    referenceGroup: null,
    adverseImpactRatio: null,
    fourFifthsViolation: false,
    disproportionateFlag: false,
    generatedAt: new Date().toISOString(),
  };
}

export default attritionRoutes;
