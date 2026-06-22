import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { prisma } from "../db.js";
import { aiClient } from "../lib/aiClient.js";

const DependencyStatus = z.object({
  status: z.enum(["ok", "degraded"]),
  detail: z.string().optional(),
});

const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  uptimeSeconds: z.number(),
  dependencies: z.object({
    database: DependencyStatus,
    aiService: DependencyStatus,
  }),
});

/**
 * GET /health — liveness + dependency readiness. NOT tenant-scoped (no auth/RLS):
 * it must answer for load balancers and probes before any session exists.
 *
 * Checks Postgres connectivity and AI-service reachability. Returns 200 with
 * `status: "degraded"` (rather than failing the whole request) when a dependency
 * is down, so the probe can distinguish "process up" from "fully ready".
 */
const healthRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness and dependency readiness check.",
        response: { 200: HealthResponse },
      },
    },
    async () => {
      const [database, aiService] = await Promise.all([
        checkDatabase(),
        checkAiService(),
      ]);

      const overall =
        database.status === "ok" && aiService.status === "ok" ? "ok" : "degraded";

      return {
        status: overall,
        uptimeSeconds: Math.round(process.uptime()),
        dependencies: { database, aiService },
      };
    },
  );
};

async function checkDatabase(): Promise<z.infer<typeof DependencyStatus>> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (err) {
    return { status: "degraded", detail: err instanceof Error ? err.message : "db unreachable" };
  }
}

async function checkAiService(): Promise<z.infer<typeof DependencyStatus>> {
  try {
    const h = await aiClient.health();
    return { status: "ok", detail: `model=${h.model} v=${h.version}` };
  } catch (err) {
    return { status: "degraded", detail: err instanceof Error ? err.message : "ai unreachable" };
  }
}

export default healthRoutes;
