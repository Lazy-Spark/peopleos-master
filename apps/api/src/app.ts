import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { env, isProduction } from "./env.js";
import authPlugin from "./plugins/auth.js";
import swaggerPlugin from "./plugins/swagger.js";
import { HttpError } from "./lib/errors.js";
import { AiServiceError } from "./lib/aiClient.js";
import { TranscriptStoreError } from "./lib/transcriptStore.js";
import healthRoutes from "./routes/health.js";
import jobRoutes from "./routes/jobs.js";
import candidateRoutes from "./routes/candidates.js";
import applicationRoutes from "./routes/applications.js";
import rankingRoutes from "./routes/rankings.js";
import auditRoutes from "./routes/audit.js";
import copilotRoutes from "./routes/copilot.js";
import interviewRoutes from "./routes/interviews.js";
import policyRoutes from "./routes/policies.js";
import hrChatRoutes from "./routes/hrChat.js";
import analyticsRoutes from "./routes/analytics.js";
import skillRoutes from "./routes/skills.js";
import attritionRoutes from "./routes/attrition.js";
import mobilityRoutes from "./routes/mobility.js";
import workflowRoutes from "./routes/workflow.js";
import assistantRoutes from "./routes/assistant.js";
import internalRoutes from "./routes/internal.js";
import internalAssistantRoutes from "./routes/internalAssistant.js";

/** All versioned business routes mount under this prefix (spec: URL-based /api/v1). */
const API_PREFIX = "/api/v1";

/**
 * Build the Fastify app: plugins, the ZodTypeProvider wiring, a uniform error
 * handler that always returns the @peopleos/schemas `ApiError` envelope, and the
 * route tree. `buildApp` is side-effect free w.r.t. the network (it does not
 * listen) so it can be reused by server.ts and by tests.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Pretty logs in dev; structured JSON (pino default) in prod.
      ...(isProduction ? {} : { transport: { target: "pino-pretty" } }),
      // Never log Authorization headers, the dev X-Org-Id tenant value, or the
      // internal service shared secret (Module 2c tool router).
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-org-id']",
        "req.headers['x-internal-secret']",
      ],
    },
    // Trust the proxy so request.ip reflects the real client behind a load balancer
    // (used in audit-log ip_address). Safe behind our own ALB; tighten if needed.
    trustProxy: true,
    // Reject unknown bodies politely rather than 500.
    bodyLimit: 1_048_576, // 1 MiB
  }).withTypeProvider<ZodTypeProvider>();

  // ── Zod as the validator + serializer for every route schema ───────────────
  // This makes the `schema: { body, querystring, params, response }` blocks on each
  // route validate against the frozen @peopleos/schemas contracts at runtime, and
  // serialize responses through them (stripping any non-contract fields — e.g. the
  // audit-only CandidateRanking.reasoning can never leak to a client).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ── Uniform error handling → ApiError envelope ─────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    const { code, status, message, details } = mapError(error);

    // 5xx are unexpected; log with stack. 4xx are client errors; log at warn.
    if (status >= 500) {
      request.log.error({ err: error, code }, "request failed");
    } else {
      request.log.warn({ code, message }, "request rejected");
    }

    return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
  });

  // 404 for unmatched routes, in the same ApiError shape.
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: { code: "NOT_FOUND", message: `Route ${request.method} ${request.url} not found` },
    });
  });

  // ── Cross-cutting plugins ──────────────────────────────────────────────────
  await app.register(swaggerPlugin);

  // auth is registered with fastify-plugin, so its onRequest hook applies app-wide.
  // Register it BEFORE rate-limit so request.auth is populated by the time the
  // rate-limit keyGenerator runs (it keys by org id; see below).
  await app.register(authPlugin);

  // Per-org / per-IP rate limiting (spec: @fastify/rate-limit, per-org limits). We
  // key by the authenticated org when present, falling back to client IP so that
  // pre-auth traffic is still bounded. Errors are emitted as the ApiError envelope.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.auth?.orgId ?? request.ip,
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: "RATE_LIMITED",
        message: `Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
        details: { max: context.max, windowMs: context.timeWindow },
      },
    }),
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  // Health/docs are NOT tenant-scoped (the rate-limit keyGenerator falls back to IP
  // for them). Business routes are mounted under /api/v1 and each handler is
  // tenant-guarded via requireTenant + withTenant.
  await app.register(healthRoutes);

  // INTERNAL tool router (Module 2c ReAct agent). Mounted at the ROOT, OUTSIDE
  // /api/v1, with NO Clerk/tenancy preHandler — it is authenticated by the
  // x-internal-secret shared secret and tenant-scoped by the orgId in each request
  // body (which the API set from the end user's authed chat session). See the trust
  // boundary doc in routes/internal.ts. These are the ONLY non-tenant business routes.
  await app.register(internalRoutes);
  // Module 10 (Agentic HR Assistant) ReAct tool dispatcher. Same trust boundary as
  // /internal/copilot/*: secret-authed (x-internal-secret), no Clerk/tenancy preHandler.
  // It re-enforces tenancy + per-tool role governance from the trusted AssistantContext
  // in each request body. See routes/internalAssistant.ts + lib/assistantTools.ts.
  await app.register(internalAssistantRoutes);

  await app.register(
    async (api) => {
      await api.register(jobRoutes);
      await api.register(candidateRoutes);
      await api.register(applicationRoutes);
      await api.register(rankingRoutes);
      await api.register(auditRoutes);
      await api.register(copilotRoutes);
      await api.register(interviewRoutes);
      await api.register(policyRoutes);
      await api.register(hrChatRoutes);
      await api.register(analyticsRoutes);
      await api.register(skillRoutes);
      await api.register(attritionRoutes);
      await api.register(mobilityRoutes);
      await api.register(workflowRoutes);
      await api.register(assistantRoutes);
    },
    { prefix: API_PREFIX },
  );

  return app;
}

/** Map any thrown error to an HTTP status + ApiError fields. No `any`. */
function mapError(error: unknown): {
  code: string;
  status: number;
  message: string;
  details?: unknown;
} {
  // Our own typed application errors (notFound/conflict/badRequest/etc).
  if (error instanceof HttpError) {
    return { code: error.code, status: error.status, message: error.message, details: error.details };
  }

  // AI downstream dependency failures → 502 Bad Gateway with its envelope code.
  if (error instanceof AiServiceError) {
    return { code: error.code, status: error.status, message: error.message, details: error.details };
  }

  // S3 transcript-store failures (Module 3) → 502: an object-store dependency fault
  // is never the client's fault and must not leak S3 internals.
  if (error instanceof TranscriptStoreError) {
    return { code: error.code, status: error.status, message: error.message, details: error.details };
  }

  // Fastify attaches `.validation` (an array) to request-schema validation failures.
  // (We check the native field directly rather than fastify-type-provider-zod's
  // `hasZodFastifySchemaValidationErrors`, which was removed in v2.1.)
  const fastifyValidation =
    typeof error === "object" && error !== null && "validation" in error
      ? (error as { validation?: unknown }).validation
      : undefined;
  if (Array.isArray(fastifyValidation)) {
    return {
      code: "VALIDATION_ERROR",
      status: 400,
      message: "Request failed schema validation.",
      details: fastifyValidation,
    };
  }

  // A raw ZodError thrown inside a handler (e.g. a serialize.parse mismatch).
  if (error instanceof ZodError) {
    return {
      code: "VALIDATION_ERROR",
      status: 400,
      message: "Payload failed contract validation.",
      details: error.flatten(),
    };
  }

  // Known Prisma error shapes we want to translate cleanly.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return mapPrismaError(error);
  }

  // Fastify errors carry a numeric statusCode (e.g. 400 for malformed JSON body).
  if (isFastifyError(error)) {
    const status = error.statusCode ?? 500;
    return {
      code: error.code ?? (status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST"),
      status,
      message: error.message,
    };
  }

  // Anything else is an unexpected server fault — never leak internals to the client.
  return {
    code: "INTERNAL_ERROR",
    status: 500,
    message: "An unexpected error occurred.",
  };
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): {
  code: string;
  status: number;
  message: string;
  details?: unknown;
} {
  switch (error.code) {
    case "P2002": // unique constraint violation
      return {
        code: "CONFLICT",
        status: 409,
        message: "A record with these unique fields already exists.",
        details: { target: error.meta?.target },
      };
    case "P2025": // record not found for update/delete
      return { code: "NOT_FOUND", status: 404, message: "The requested record was not found." };
    case "P2003": // foreign key constraint violation
      return {
        code: "BAD_REQUEST",
        status: 400,
        message: "A referenced record does not exist.",
        details: { field: error.meta?.field_name },
      };
    default:
      return { code: "INTERNAL_ERROR", status: 500, message: "A database error occurred." };
  }
}

interface FastifyLikeError {
  statusCode?: number;
  code?: string;
  message: string;
}

function isFastifyError(error: unknown): error is FastifyLikeError {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    ("statusCode" in error || "code" in error)
  );
}
