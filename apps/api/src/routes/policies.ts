import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  IngestPolicyRequest,
  IngestPolicyResponse,
  pageResponse,
  PolicyDocument,
  PolicyIngestRequest,
} from "@peopleos/schemas";
import { withTenant } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { writeAudit } from "../lib/audit.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { aiClient } from "../lib/aiClient.js";
import { serializePolicyDocument } from "../lib/serialize.js";

/**
 * Module 4 / Layer 2C — Policy (knowledge base) document management. Mounted under
 * /api/v1, tenant-scoped via requireTenant + withTenant(orgId).
 *
 *   POST   /api/v1/policies      ingest a policy (chunk + embed + version) — ADMIN/HRBP
 *   GET    /api/v1/policies      list ACTIVE policy documents
 *   DELETE /api/v1/policies/:id  archive a policy (status ARCHIVED, chunks active=false) — ADMIN/HRBP
 *
 * Ingestion runs the Layer-2C pipeline in the AI service (semantic chunk + embed +
 * SimHash) and stores the resulting DocumentChunk rows with their dense embeddings.
 * Versioning/dedup (step 5): a new upload whose title matches a prior ACTIVE doc — or
 * whose SimHash is identical to one — SUPERSEDES it (prior doc → SUPERSEDED, its chunks
 * → active=false) and increments the version. Only ACTIVE chunks are retrievable, so the
 * chatbot always answers from the live policy set.
 */

/** Roles permitted to create/delete policy documents (people-ops content stewards). */
const POLICY_WRITE_ROLES = new Set(["ADMIN", "HRBP"]);

const PolicyIdParam = z.object({ id: z.string().uuid() });
const PolicyListResponse = pageResponse(PolicyDocument);

const policyRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Ingest a policy document ────────────────────────────────────────────────
  r.post(
    "/policies",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["policies"],
        summary: "Ingest a policy document into the knowledge base (Layer 2C). ADMIN/HRBP.",
        description:
          "Creates a PolicyDocument (status ACTIVE), runs the AI service's document pipeline (semantic chunk + embed + SimHash), and stores the chunks as DocumentChunk rows (dense Float[] embeddings, active=true). Versioning: if a prior ACTIVE doc with the same title — or an identical SimHash — exists, it is SUPERSEDED (its chunks deactivated) and this version is bumped. Restricted to ADMIN/HRBP.",
        body: IngestPolicyRequest,
        response: {
          200: IngestPolicyResponse,
          400: ApiError,
          401: ApiError,
          403: ApiError,
          502: ApiError,
        },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const body = request.body;

      if (!POLICY_WRITE_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may ingest policy documents.");
      }

      // The contract guarantees exactly one of rawText / fileUrl. Dev ingests rawText;
      // a prod file fetcher (S3/URL → text) is out of scope here, so reject fileUrl
      // with a clear 400 rather than silently embedding nothing.
      if (!body.rawText) {
        throw badRequest(
          "fileUrl ingestion is not supported in this environment; provide rawText.",
        );
      }
      const rawText = body.rawText;

      // ── Phase 1: create the PolicyDocument shell + compute its version ─────────
      // version = (prior ACTIVE same-title version) + 1, else 1. We create the doc
      // ACTIVE first so the AI pipeline has a real docId to attach chunks to.
      const created = await withTenant(orgId, async (tx) => {
        const priorActive = await tx.policyDocument.findFirst({
          where: { title: body.title, status: "ACTIVE" },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const version = (priorActive?.version ?? 0) + 1;

        return tx.policyDocument.create({
          data: {
            orgId,
            title: body.title,
            docType: body.docType,
            effectiveDate: body.effectiveDate ? new Date(body.effectiveDate) : null,
            ownerId: body.ownerId ?? null,
            status: "ACTIVE",
            version,
            // simhash + chunksIndexedAt are filled in after the pipeline runs.
          },
        });
      });

      // ── Phase 2: run the AI document pipeline (chunk + embed + SimHash) ────────
      // Outside the transaction — a 30s LLM/embedding call must not hold a DB
      // connection / RLS transaction open.
      const ingest = await aiClient.ingestPolicy(
        PolicyIngestRequest.parse({
          orgId,
          docId: created.id,
          docType: body.docType,
          title: body.title,
          rawText,
        }),
      );

      // ── Phase 3: persist chunks, run supersede/version logic, finalise the doc ─
      const result = await withTenant(orgId, async (tx) => {
        // SimHash / version supersede: a PRIOR active doc with the same title OR an
        // identical SimHash is the old version of this content. Mark it SUPERSEDED and
        // deactivate its chunks so retrieval only ever sees the live set (step 5).
        const superseded = await tx.policyDocument.findFirst({
          where: {
            id: { not: created.id },
            status: "ACTIVE",
            OR: [{ title: body.title }, { simhash: ingest.simhash }],
          },
          orderBy: { version: "desc" },
          select: { id: true },
        });

        if (superseded) {
          await tx.policyDocument.update({
            where: { id: superseded.id },
            data: { status: "SUPERSEDED" },
          });
          await tx.documentChunk.updateMany({
            where: { docId: superseded.id },
            data: { active: false },
          });
        }

        // Store the new doc's chunks (orgId set → RLS WITH CHECK; active=true).
        if (ingest.chunks.length > 0) {
          await tx.documentChunk.createMany({
            data: ingest.chunks.map((c) => ({
              orgId,
              docId: created.id,
              sectionPath: c.sectionPath,
              text: c.text,
              charStart: c.charStart,
              charEnd: c.charEnd,
              pageNumber: c.pageNumber,
              tokenCount: c.tokenCount,
              embedding: c.embedding,
              active: true,
            })),
          });
        }

        // Finalise: stamp the SimHash + chunksIndexedAt on the new doc.
        const finalised = await tx.policyDocument.update({
          where: { id: created.id },
          data: { simhash: ingest.simhash, chunksIndexedAt: new Date() },
        });

        await writeAudit(tx, {
          actorId: userId,
          action: "policy.ingest",
          entityType: "policy_document",
          entityId: created.id,
          payload: {
            title: body.title,
            docType: body.docType,
            version: finalised.version,
            chunkCount: ingest.chunks.length,
            supersededDocumentId: superseded?.id ?? null,
            modelVersion: ingest.modelVersion,
          },
          ip: request.ip,
        });

        return { document: finalised, supersededId: superseded?.id ?? null };
      });

      return IngestPolicyResponse.parse({
        document: serializePolicyDocument(result.document),
        chunkCount: ingest.chunks.length,
        supersededDocumentId: result.supersededId,
      });
    },
  );

  // ── List ACTIVE policy documents ────────────────────────────────────────────
  r.get(
    "/policies",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["policies"],
        summary: "List the org's ACTIVE policy documents.",
        description:
          "Returns the live knowledge-base documents (status ACTIVE) for the tenant, newest first. Superseded/archived versions are omitted.",
        response: { 200: PolicyListResponse, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      return withTenant(orgId, async (tx) => {
        const rows = await tx.policyDocument.findMany({
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
        });
        return { items: rows.map(serializePolicyDocument), nextCursor: null };
      });
    },
  );

  // ── Archive a policy document ───────────────────────────────────────────────
  r.delete(
    "/policies/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["policies"],
        summary: "Archive a policy document (soft delete). ADMIN/HRBP.",
        description:
          "Sets the document status to ARCHIVED and deactivates its chunks (active=false) so it is no longer retrievable by the chatbot. The row + chunks are retained for audit. Restricted to ADMIN/HRBP.",
        params: PolicyIdParam,
        response: { 200: PolicyDocument, 401: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id } = request.params;

      if (!POLICY_WRITE_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may archive policy documents.");
      }

      return withTenant(orgId, async (tx) => {
        const existing = await tx.policyDocument.findUnique({ where: { id }, select: { id: true } });
        if (!existing) throw notFound(`Policy document ${id} not found`);

        await tx.documentChunk.updateMany({
          where: { docId: id },
          data: { active: false },
        });
        const archived = await tx.policyDocument.update({
          where: { id },
          data: { status: "ARCHIVED" },
        });

        await writeAudit(tx, {
          actorId: userId,
          action: "policy.archive",
          entityType: "policy_document",
          entityId: id,
          payload: { title: archived.title, version: archived.version },
          ip: request.ip,
        });

        return serializePolicyDocument(archived);
      });
    },
  );
};

export default policyRoutes;
