import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import {
  ApiError,
  ApplicationStage,
  CandidateProfile,
  ToolCandidateHit,
  ToolCandidateRequest,
  ToolCandidateResponse,
  ToolPipelineStats,
  ToolPipelineStatsRequest,
  ToolSearchCandidatesRequest,
  ToolSearchCandidatesResponse,
} from "@peopleos/schemas";
import { withTenant } from "../db.js";
import { requireInternalSecret } from "../lib/internalSecret.js";

/**
 * The pre-validation input shape of a hit: plain strings (the branded `CandidateId`
 * is produced by `.parse()`). We assemble these, then `ToolSearchCandidatesResponse
 * .parse()` validates + brands — the same pattern as the serialize.ts helpers.
 */
type ToolCandidateHitInput = z.input<typeof ToolCandidateHit>;

/**
 * INTERNAL tool router (Module 2c — Recruiter Chat ReAct agent tools).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TRUST BOUNDARY — read before changing anything in this file.
 *
 * These routes are mounted at the ROOT (outside /api/v1) and DELIBERATELY have NO
 * Clerk/tenancy preHandler. They are the ONLY non-tenant-preHandler business routes
 * in the API. They exist so the Python AI service's ReAct agent can call back into
 * the API to run its tools (search_candidates / get_pipeline_stats /
 * summarise_candidate) while a recruiter is chatting.
 *
 * Authentication is a SHARED SECRET on the internal network:
 *   - The caller MUST send `x-internal-secret: <env.AI_SERVICE_SECRET>`.
 *   - We compare it in CONSTANT TIME (timingSafeEqual) → no timing oracle.
 *   - If AI_SERVICE_SECRET is UNSET, we refuse ALL internal calls (fail-closed).
 *     In production env.ts makes the secret mandatory at boot.
 *
 * Tenancy: each request carries `orgId` IN THE BODY (the Tool*Request contracts).
 * That orgId was set by the API itself on the authenticated /api/v1/copilot/chat
 * request (from the end user's Clerk session) and propagated to the AI service,
 * which echoes it back here. We run every query inside withTenant(orgId) so RLS
 * scopes it exactly as a first-party request would. The secret authenticates the
 * SERVICE; the body's orgId selects the tenant the service was authorised for.
 *
 * Network posture: bind these only on the internal network / service mesh; never
 * expose /internal/* on the public ingress.
 *
 * The constant-time `x-internal-secret` guard (`requireInternalSecret`) is shared
 * with the Module 10 assistant tool router and lives in lib/internalSecret.ts.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Pull a one-line "headline" + top skills from a stored profile (best-effort). */
function summariseProfile(rawProfile: unknown): {
  headline: string | null;
  topSkills: string[];
} {
  const parsed = CandidateProfile.safeParse(rawProfile);
  if (!parsed.success) return { headline: null, topSkills: [] };
  const profile = parsed.data;
  // Headline: the most-recent / current role, formatted "Title at Company".
  const current = profile.experience.find((e) => e.isCurrent) ?? profile.experience[0];
  const headline = current ? `${current.title} at ${current.company}` : null;
  const topSkills = profile.skills.slice(0, 8).map((s) => s.canonicalName);
  return { headline, topSkills };
}

/** Stage→stage conversion rate as count(to)/count(from), clamped to [0,1]. */
function rate(from: number, to: number): number {
  if (from <= 0) return 0;
  return Math.max(0, Math.min(1, to / from));
}

const internalRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // search_candidates — text search over the org's candidate pool (Module 2c tool).
  r.post(
    "/internal/copilot/search-candidates",
    {
      preHandler: requireInternalSecret,
      schema: {
        tags: ["internal"],
        summary: "ReAct tool: text-search the org's candidate pool.",
        body: ToolSearchCandidatesRequest,
        response: { 200: ToolSearchCandidatesResponse, 400: ApiError, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId, query, jobId, limit } = request.body;
      const q = query.trim().toLowerCase();

      return withTenant(orgId, async (tx) => {
        // If a jobId is provided, narrow to that job's applicants; otherwise the
        // whole pool. Fetch a bounded window (4×limit, capped) and rank in-memory:
        // the candidate `profile` is a JSON column, so skill/profile matching is not
        // expressible as an indexable WHERE. This is the Phase-2 stopgap until the
        // Pinecone vector search (spec 2c) replaces it.
        const candidateIds = jobId
          ? (
              await tx.application.findMany({
                where: { jobId },
                select: { candidateId: true },
              })
            ).map((a) => a.candidateId)
          : null;

        const rows = await tx.candidate.findMany({
          where: candidateIds ? { id: { in: candidateIds } } : {},
          orderBy: { createdAt: "desc" },
          take: Math.min(limit * 4, 100),
        });

        const matches: ToolCandidateHitInput[] = [];
        for (const row of rows) {
          const { headline, topSkills } = summariseProfile(row.profile);
          // Build a single haystack from name + headline + skills for substring match.
          const haystack = [row.name ?? "", headline ?? "", topSkills.join(" ")]
            .join(" ")
            .toLowerCase();
          // Empty query → return the recent window; otherwise require a substring hit.
          if (q.length === 0 || haystack.includes(q)) {
            matches.push({
              candidateId: row.id,
              name: row.name,
              headline,
              topSkills,
            });
          }
          if (matches.length >= limit) break;
        }

        return ToolSearchCandidatesResponse.parse({ candidates: matches });
      });
    },
  );

  // get_pipeline_stats — stage counts + conversion rates + days open (Module 2c).
  r.post(
    "/internal/copilot/pipeline-stats",
    {
      preHandler: requireInternalSecret,
      schema: {
        tags: ["internal"],
        summary: "ReAct tool: pipeline stage counts, conversion rates, days open.",
        body: ToolPipelineStatsRequest,
        response: { 200: ToolPipelineStats, 400: ApiError, 401: ApiError, 404: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, jobId } = request.body;

      const stats = await withTenant(orgId, async (tx) => {
        const job = await tx.jobOpening.findUnique({
          where: { id: jobId },
          select: { id: true, createdAt: true, closedAt: true },
        });
        if (!job) return null;

        const grouped = await tx.application.groupBy({
          by: ["stage"],
          where: { jobId },
          _count: { _all: true },
        });

        const byStage: Record<string, number> = {};
        let total = 0;
        for (const g of grouped) {
          const n = g._count._all;
          byStage[g.stage] = n;
          total += n;
        }
        // Ensure every stage key is present (0 where none), so the agent sees the
        // full funnel shape rather than a sparse object.
        for (const stage of ApplicationStage.options) {
          if (!(stage in byStage)) byStage[stage] = 0;
        }

        // Funnel conversion rates along the standard progression. Each is the share
        // of the earlier stage that reached the later one (count-based, advisory).
        // Read via a helper that defaults missing keys to 0 (noUncheckedIndexedAccess).
        const at = (stage: string): number => byStage[stage] ?? 0;
        const conversionRates: Record<string, number> = {
          "applied→screening": rate(at("APPLIED"), at("SCREENING")),
          "screening→interview": rate(at("SCREENING"), at("INTERVIEW")),
          "interview→offer": rate(at("INTERVIEW"), at("OFFER")),
          "offer→hired": rate(at("OFFER"), at("HIRED")),
        };

        // Days the role has been open: from createdAt to closedAt (or now if open).
        const end = job.closedAt ?? new Date();
        const daysOpen = Math.max(
          0,
          Math.floor((end.getTime() - job.createdAt.getTime()) / 86_400_000),
        );

        return ToolPipelineStats.parse({
          jobId,
          total,
          byStage,
          conversionRates,
          daysOpen,
        });
      });

      if (!stats) {
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: `Job ${jobId} not found` } });
      }
      return stats;
    },
  );

  // summarise_candidate — profile + latest ranking tier (Module 2c tool).
  r.post(
    "/internal/copilot/candidate",
    {
      preHandler: requireInternalSecret,
      schema: {
        tags: ["internal"],
        summary: "ReAct tool: a candidate's profile + latest ranking tier.",
        body: ToolCandidateRequest,
        response: { 200: ToolCandidateResponse, 400: ApiError, 401: ApiError, 404: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, candidateId } = request.body;

      const result = await withTenant(orgId, async (tx) => {
        const candidate = await tx.candidate.findUnique({ where: { id: candidateId } });
        if (!candidate) return null;

        // The most recent ranking across any job gives the agent a quick quality read.
        const latest = await tx.candidateRanking.findFirst({
          where: { candidateId },
          orderBy: { scoredAt: "desc" },
          select: { tier: true },
        });

        return ToolCandidateResponse.parse({
          candidateId: candidate.id,
          name: candidate.name,
          profile: candidate.profile == null ? null : CandidateProfile.parse(candidate.profile),
          latestTier: latest?.tier ?? null,
        });
      });

      if (!result) {
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: `Candidate ${candidateId} not found` } });
      }
      return result;
    },
  );
};

export default internalRoutes;
