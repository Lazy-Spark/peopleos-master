import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  DisparityRequest,
  JobBiasAuditRequest,
  JobBiasAuditResponse,
  RankingTier,
  type DisparityRecord as TDisparityRecord,
} from "@peopleos/schemas";
import { withTenant } from "../db.js";
import { aiClient } from "../lib/aiClient.js";
import { writeAudit } from "../lib/audit.js";
import { forbidden, notFound } from "../lib/errors.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";

const JobIdParam = z.object({ id: z.string().uuid() });

/** Roles permitted to run a bias audit (people-ops governance — spec personas). */
const AUDIT_ROLES = new Set(["ADMIN", "HRBP"]);

/**
 * Bias / adverse-impact audit routes (spec Module 1 step 6 + the ethics checklist).
 *
 *   POST /api/v1/jobs/:id/bias-audit   body: JobBiasAuditRequest
 *
 * PeopleOS deliberately does NOT store protected attributes. The demographic
 * mapping (candidateId → group) is supplied PER REQUEST by the org (only where
 * legitimate EEOC self-id data exists) and is NEVER persisted: it is joined in
 * memory with the job's existing candidate_rankings, handed to the AI service's
 * statistics endpoint (no LLM involved), and discarded. The audit payload we write
 * records only the job id + group LABELS' aggregate counts, never per-candidate
 * group assignments.
 *
 * Restricted to ADMIN / HRBP — disparity data is sensitive governance material and
 * not for recruiters/managers. A 403 is returned otherwise.
 */
const auditRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/jobs/:id/bias-audit",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["audit"],
        summary: "Run an adverse-impact (EEOC 4/5ths) bias audit on a job's rankings.",
        description:
          "Joins the job's persisted candidate rankings with a per-request demographic mapping (never stored) and returns selection-rate parity statistics. Restricted to ADMIN/HRBP.",
        params: JobIdParam,
        body: JobBiasAuditRequest,
        response: {
          200: JobBiasAuditResponse,
          400: ApiError,
          401: ApiError,
          403: ApiError,
          404: ApiError,
          502: ApiError,
        },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id: jobId } = request.params;
      const { demographics, selectionTiers } = request.body;

      // ── RBAC: governance-only ────────────────────────────────────────────────
      if (!AUDIT_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may run a bias audit.");
      }

      // ── Load the job's rankings + write the audit entry (tenant-scoped) ───────
      const rankings = await withTenant(orgId, async (tx) => {
        const job = await tx.jobOpening.findUnique({ where: { id: jobId }, select: { id: true } });
        if (!job) throw notFound(`Job ${jobId} not found`);

        // Newest ranking per candidate for this job. Ordered newest-first so the
        // first row seen per candidate is the current one.
        const rows = await tx.candidateRanking.findMany({
          where: { jobId },
          orderBy: { scoredAt: "desc" },
          select: { candidateId: true, finalScore: true, tier: true },
        });

        await writeAudit(tx, {
          actorId: userId,
          action: "job.bias_audit",
          entityType: "job_opening",
          entityId: jobId,
          // Governance metadata only — NO per-candidate group assignments are stored
          // (PeopleOS never persists protected attributes). We record how many groups
          // and how many candidates were supplied for the run.
          payload: {
            jobId,
            demographicGroups: [...new Set(demographics.map((d) => d.group))].length,
            mappedCandidates: demographics.length,
            ...(selectionTiers ? { selectionTiers } : {}),
          },
          ip: request.ip,
        });

        return rows;
      });

      // ── Join rankings ⋈ demographics by candidateId (in memory; never stored) ─
      // Latest score/tier per candidate (rows are newest-first).
      const latestByCandidate = new Map<string, { finalScore: number; tier: z.infer<typeof RankingTier> }>();
      for (const row of rankings) {
        if (!latestByCandidate.has(row.candidateId)) {
          latestByCandidate.set(row.candidateId, { finalScore: row.finalScore, tier: row.tier });
        }
      }

      const records: TDisparityRecord[] = [];
      const unmatched: string[] = [];
      for (const { candidateId, group } of demographics) {
        const ranking = latestByCandidate.get(candidateId);
        if (!ranking) {
          // No ranking yet for this candidate → excluded from the report.
          unmatched.push(candidateId);
          continue;
        }
        records.push({ group, score: ranking.finalScore, tier: ranking.tier });
      }

      // No matched records → return an empty report rather than calling the AI with
      // an empty set (DisparityRequest requires >= 1 record).
      if (records.length === 0) {
        return JobBiasAuditResponse.parse({
          jobId,
          report: emptyReport(),
          unmatched,
        });
      }

      // ── Compute disparity statistics via the AI service (no LLM) ──────────────
      const disparityRequest = DisparityRequest.parse({
        records,
        ...(selectionTiers ? { selectionTiers } : {}),
      });
      const report = await aiClient.disparity(disparityRequest);

      return JobBiasAuditResponse.parse({ jobId, report, unmatched });
    },
  );
};

/** A well-formed empty DisparityReport for the no-matched-candidates case. */
function emptyReport(): z.infer<typeof JobBiasAuditResponse>["report"] {
  return {
    groups: [],
    referenceGroup: null,
    adverseImpactRatio: null,
    fourFifthsViolation: false,
    disproportionateFlag: false,
    generatedAt: new Date().toISOString(),
  };
}

export default auditRoutes;
