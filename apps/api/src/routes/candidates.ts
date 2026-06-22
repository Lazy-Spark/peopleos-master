import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  Candidate,
  CandidateCreate,
  PageQuery,
  pageResponse,
} from "@peopleos/schemas";
import { withTenant } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { writeAudit } from "../lib/audit.js";
import { notFound } from "../lib/errors.js";
import { serializeCandidate } from "../lib/serialize.js";

const CandidateIdParam = z.object({ id: z.string().uuid() });
const CandidateListResponse = pageResponse(Candidate);

/**
 * Candidate routes (spec Layer 2A output / Layer 5a ATS).
 *
 * list  : GET  /api/v1/candidates
 * create: POST /api/v1/candidates   (profile is filled in later by the resume pipeline)
 * get   : GET  /api/v1/candidates/:id
 *
 * The structured `profile` (CandidateProfile) is produced asynchronously by the AI
 * service's resume pipeline; on create it is null until parsing completes. All queries
 * run through withTenant so RLS isolates them to the caller's org.
 */
const candidateRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/candidates",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["candidates"],
        summary: "List candidates (cursor-paginated).",
        querystring: PageQuery,
        response: { 200: CandidateListResponse, 400: ApiError, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { cursor, limit } = request.query;

      return withTenant(orgId, async (tx) => {
        const rows = await tx.candidate.findMany({
          orderBy: { createdAt: "desc" },
          take: limit + 1,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        const page = rows.slice(0, limit);
        const nextCursor = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
        return { items: page.map(serializeCandidate), nextCursor };
      });
    },
  );

  r.post(
    "/candidates",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["candidates"],
        summary: "Create a candidate (profile parsed asynchronously).",
        body: CandidateCreate,
        response: { 201: Candidate, 400: ApiError, 401: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, userId } = tenant(request);
      const body = request.body;

      const created = await withTenant(orgId, async (tx) => {
        const candidate = await tx.candidate.create({
          data: {
            orgId,
            name: body.name ?? null,
            email: body.email ?? null,
            phone: body.phone ?? null,
            linkedinUrl: body.linkedinUrl ?? null,
            githubUrl: body.githubUrl ?? null,
            source: body.source,
            resumeFilePath: body.resumeFilePath ?? null,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "candidate.create",
          entityType: "candidate",
          entityId: candidate.id,
          // Intentionally minimal payload — no raw resume text / PII beyond source.
          payload: { source: candidate.source },
          ip: request.ip,
        });
        return candidate;
      });

      return reply.code(201).send(serializeCandidate(created));
    },
  );

  r.get(
    "/candidates/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["candidates"],
        summary: "Get a single candidate.",
        params: CandidateIdParam,
        response: { 200: Candidate, 401: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { id } = request.params;

      return withTenant(orgId, async (tx) => {
        const candidate = await tx.candidate.findUnique({ where: { id } });
        if (!candidate) throw notFound(`Candidate ${id} not found`);
        return serializeCandidate(candidate);
      });
    },
  );
};

export default candidateRoutes;
