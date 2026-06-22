import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  Application,
  ApplicationCreate,
  ApplicationStageUpdate,
  PageQuery,
  pageResponse,
} from "@peopleos/schemas";
import { withTenant } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { writeAudit } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { serializeApplication } from "../lib/serialize.js";
import { enqueueRanking } from "../queue/rankingQueue.js";

const ApplicationIdParam = z.object({ id: z.string().uuid() });
const ApplicationListResponse = pageResponse(Application);
/** `jobId` is required to list a pipeline; `cursor`/`limit` come from PageQuery. */
const ApplicationListQuery = PageQuery.extend({ jobId: z.string().uuid() });

/**
 * Application routes (spec Layer 5a — ATS pipeline).
 *
 * list   : GET   /api/v1/applications?jobId=...        pipeline for one job
 * create : POST  /api/v1/applications                  candidate applies to a job
 * advance: PATCH /api/v1/applications/:id/stage        move stage (Kanban transition)
 *
 * Foreign-key existence is checked inside the same tenant transaction so RLS guarantees
 * the candidate/job belong to the caller's org (a cross-tenant id is invisible → 404).
 */
const applicationRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/applications",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["applications"],
        summary: "List applications for a job (cursor-paginated).",
        querystring: ApplicationListQuery,
        response: { 200: ApplicationListResponse, 400: ApiError, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { jobId, cursor, limit } = request.query;

      return withTenant(orgId, async (tx) => {
        const rows = await tx.application.findMany({
          where: { jobId },
          orderBy: { appliedAt: "desc" },
          take: limit + 1,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        const page = rows.slice(0, limit);
        const nextCursor = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
        return { items: page.map(serializeApplication), nextCursor };
      });
    },
  );

  r.post(
    "/applications",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["applications"],
        summary: "Create an application (candidate applies to a job).",
        body: ApplicationCreate,
        response: {
          201: Application,
          400: ApiError,
          401: ApiError,
          404: ApiError,
          409: ApiError,
        },
      },
    },
    async (request, reply) => {
      const { orgId, userId } = tenant(request);
      const { candidateId, jobId } = request.body;

      const created = await withTenant(orgId, async (tx) => {
        // Under RLS these only resolve if both belong to the caller's org.
        const [candidate, job] = await Promise.all([
          tx.candidate.findUnique({ where: { id: candidateId } }),
          tx.jobOpening.findUnique({ where: { id: jobId } }),
        ]);
        if (!candidate) throw notFound(`Candidate ${candidateId} not found`);
        if (!job) throw notFound(`Job ${jobId} not found`);

        // Unique([candidateId, jobId]) — surface a clean 409 instead of a raw P2002.
        const existing = await tx.application.findUnique({
          where: { candidateId_jobId: { candidateId, jobId } },
        });
        if (existing) {
          throw conflict("Candidate has already applied to this job", {
            applicationId: existing.id,
          });
        }

        const application = await tx.application.create({
          // stage/status default to APPLIED/ACTIVE in the schema.
          data: { orgId, candidateId, jobId },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "application.create",
          entityType: "application",
          entityId: application.id,
          payload: { candidateId, jobId },
          ip: request.ip,
        });
        return application;
      });

      // AUTO-TRIGGER (spec Module 1: "new candidate applies for a job opening").
      // Enqueue the AI screening AFTER the tenant tx has committed, so the worker
      // always sees the persisted application. Best-effort: a Redis/enqueue failure
      // must NEVER fail the create — the recruiter can still rank manually via
      // POST /applications/:id/rank. We catch + log and continue.
      try {
        await enqueueRanking({ orgId, applicationId: created.id });
      } catch (err) {
        request.log.error(
          { err, applicationId: created.id },
          "failed to enqueue ranking auto-trigger (application still created)",
        );
      }

      return reply.code(201).send(serializeApplication(created));
    },
  );

  r.patch(
    "/applications/:id/stage",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["applications"],
        summary: "Advance an application to a new pipeline stage.",
        params: ApplicationIdParam,
        body: ApplicationStageUpdate,
        response: { 200: Application, 400: ApiError, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId } = tenant(request);
      const { id } = request.params;
      const { stage } = request.body;

      return withTenant(orgId, async (tx) => {
        const application = await tx.application.findUnique({ where: { id } });
        if (!application) throw notFound(`Application ${id} not found`);
        if (application.stage === stage) {
          throw badRequest(`Application is already in stage ${stage}`);
        }

        const updated = await tx.application.update({
          where: { id },
          data: { stage },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "application.advance_stage",
          entityType: "application",
          entityId: id,
          payload: { from: application.stage, to: stage },
          ip: request.ip,
        });
        return serializeApplication(updated);
      });
    },
  );
};

export default applicationRoutes;
