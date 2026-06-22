import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError, CandidateRanking } from "@peopleos/schemas";
import { badRequest, notFound } from "../lib/errors.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { RankingNotFoundError, rankApplication } from "../services/ranking.js";

const ApplicationIdParam = z.object({ id: z.string().uuid() });

/**
 * Ranking routes (spec Module 1 — AI Resume Screening & Candidate Ranking).
 *
 *   POST /api/v1/applications/:id/rank
 *
 * The pipeline (load app+candidate+job+org via withTenant, build orgContext, call
 * the AI service, persist the ranking incl. the audit-only chain-of-thought
 * reasoning, update Application.aiRanking, write the AuditLog, and return the
 * CoT-free CandidateRanking) lives in the shared `rankApplication` service so the
 * single-rank route, the batch job-pipeline route, and the BullMQ auto-trigger
 * worker all behave identically.
 *
 * This route is a thin adapter: it resolves the tenant context, calls the service,
 * and maps the discriminated result onto HTTP — a `skipped` result (candidate has
 * no parsed profile) becomes a clean 400; a missing application becomes a 404.
 */
const rankingRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/applications/:id/rank",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["rankings"],
        summary:
          "Run the AI resume-screening pipeline for an application and persist the ranking.",
        description:
          "Scores the application's candidate against the job (Module 1). The chain-of-thought reasoning is stored server-side for audit and is NEVER included in the response.",
        params: ApplicationIdParam,
        // The response is the full CandidateRanking contract — which has NO reasoning
        // field (it was deliberately excluded from the frozen schema). The response
        // schema therefore enforces CoT-free output structurally.
        response: {
          200: CandidateRanking,
          400: ApiError,
          401: ApiError,
          404: ApiError,
          502: ApiError,
        },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id } = request.params;

      let result;
      try {
        result = await rankApplication(orgId, id, {
          actorId: userId,
          userRole: role,
          ip: request.ip,
        });
      } catch (err) {
        // The service does not know about HTTP; translate its not-found here.
        if (err instanceof RankingNotFoundError) throw notFound(err.message);
        throw err;
      }

      if (result.status === "skipped") {
        throw badRequest(result.reason, { candidateId: result.candidateId });
      }

      // The response schema (CandidateRanking) has no `reasoning` field, so even if a
      // future change leaked it onto this object the serializer would strip it.
      return result.ranking;
    },
  );
};

export default rankingRoutes;
