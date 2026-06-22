import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  ApplicationStage,
  JobOpening,
  JobOpeningCreate,
  PageQuery,
  PipelineEntry,
  RankJobResponse,
  pageResponse,
} from "@peopleos/schemas";
import { withTenant } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { writeAudit } from "../lib/audit.js";
import { notFound } from "../lib/errors.js";
import { serializeApplication, serializeCandidate, serializeJob } from "../lib/serialize.js";
import { RankingNotFoundError, rankJobPipeline } from "../services/ranking.js";

const JobIdParam = z.object({ id: z.string().uuid() });
const JobListResponse = pageResponse(JobOpening);
const PipelinePageResponse = pageResponse(PipelineEntry);

/**
 * Optional `?stages=SCREENING,APPLIED` filter for the batch-rank endpoint. A
 * comma-separated list of ApplicationStage values; absent → the pipeline default
 * ([SCREENING]). Parsed/validated here so an unknown stage is a clean 400.
 */
const RankJobQuery = z.object({
  stages: z
    .string()
    .optional()
    .transform((v) => (v == null ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean)))
    .pipe(z.array(ApplicationStage).nonempty().optional()),
});

/**
 * JobOpening routes (spec Layer 5a — ATS job management).
 *
 * list  : GET  /api/v1/jobs              cursor-paginated, tenant-scoped
 * create: POST /api/v1/jobs              creates a DRAFT job (JdStructured parsed later)
 * get   : GET  /api/v1/jobs/:id          single job
 *
 * Every handler runs inside withTenant(orgId, ...) so RLS scopes the queries to the
 * caller's org. Inputs and outputs are validated against the frozen @peopleos/schemas
 * contracts via the ZodTypeProvider, so the OpenAPI doc and runtime stay in lockstep.
 */
const jobRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/jobs",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["jobs"],
        summary: "List job openings (cursor-paginated).",
        querystring: PageQuery,
        response: { 200: JobListResponse, 400: ApiError, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { cursor, limit } = request.query;

      return withTenant(orgId, async (tx) => {
        // Fetch limit+1 to know whether another page exists, without a count query.
        const rows = await tx.jobOpening.findMany({
          orderBy: { createdAt: "desc" },
          take: limit + 1,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        const page = rows.slice(0, limit);
        const nextCursor = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
        return { items: page.map(serializeJob), nextCursor };
      });
    },
  );

  r.post(
    "/jobs",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["jobs"],
        summary: "Create a job opening (starts in DRAFT).",
        body: JobOpeningCreate,
        response: { 201: JobOpening, 400: ApiError, 401: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, userId } = tenant(request);
      const body = request.body;

      const created = await withTenant(orgId, async (tx) => {
        const job = await tx.jobOpening.create({
          data: {
            orgId,
            title: body.title,
            department: body.department ?? null,
            level: body.level ?? null,
            location: body.location ?? null,
            type: body.type,
            // status defaults to DRAFT in the schema; jdStructured is parsed
            // asynchronously by the AI service after creation.
            jdText: body.jdText ?? null,
            hiringManagerId: body.hiringManagerId ?? null,
            recruiterId: body.recruiterId ?? null,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "job.create",
          entityType: "job_opening",
          entityId: job.id,
          payload: { title: job.title, type: job.type },
          ip: request.ip,
        });
        return job;
      });

      return reply.code(201).send(serializeJob(created));
    },
  );

  r.get(
    "/jobs/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["jobs"],
        summary: "Get a single job opening.",
        params: JobIdParam,
        response: { 200: JobOpening, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;

      return withTenant(orgId, async (tx) => {
        const job = await tx.jobOpening.findUnique({ where: { id } });
        if (!job) throw notFound(`Job ${id} not found`);
        return serializeJob(job);
      });
    },
  );

  r.get(
    "/jobs/:id/applications",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["jobs"],
        summary: "List a job's applications joined with their candidates (pipeline view).",
        params: JobIdParam,
        querystring: PageQuery,
        response: { 200: PipelinePageResponse, 400: ApiError, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;
      const { cursor, limit } = request.query;

      return withTenant(orgId, async (tx) => {
        // Confirm the job exists in this tenant (RLS-scoped) so a missing/cross-org
        // job returns a clean 404 rather than an empty page.
        const job = await tx.jobOpening.findUnique({ where: { id }, select: { id: true } });
        if (!job) throw notFound(`Job ${id} not found`);

        const rows = await tx.application.findMany({
          where: { jobId: id },
          orderBy: { appliedAt: "desc" },
          take: limit + 1,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          include: { candidate: true },
        });
        const page = rows.slice(0, limit);
        const nextCursor = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
        return {
          items: page.map((row) => ({
            application: serializeApplication(row),
            candidate: serializeCandidate(row.candidate),
          })),
          nextCursor,
        };
      });
    },
  );

  r.post(
    "/jobs/:id/rank",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["jobs"],
        summary: "Batch-screen a job's pipeline (Module 1 — AI candidate ranking).",
        description:
          "Scores every application in the requested stages (default SCREENING) whose candidate has a parsed profile, persists each ranking with its audit-only chain-of-thought, and returns the rankings sorted best-first (CoT-free) plus any skipped candidates. Tenant-scoped and audited.",
        params: JobIdParam,
        querystring: RankJobQuery,
        response: {
          200: RankJobResponse,
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
      const { stages } = request.query;

      try {
        return await rankJobPipeline(orgId, id, {
          actorId: userId,
          userRole: role,
          ip: request.ip,
          stages,
        });
      } catch (err) {
        if (err instanceof RankingNotFoundError) throw notFound(err.message);
        throw err;
      }
    },
  );
};

export default jobRoutes;
