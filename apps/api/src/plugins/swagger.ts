import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

/**
 * OpenAPI 3.1 spec generation + Swagger UI at /docs.
 *
 * `jsonSchemaTransform` converts the Zod schemas attached to each route
 * (via the ZodTypeProvider) into JSON Schema for the OpenAPI document, so the
 * spec stays in lockstep with the @peopleos/schemas contracts — no hand-written
 * OpenAPI to drift.
 */
const swaggerPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "PeopleOS API",
        description:
          "PeopleOS REST API — ATS + HRMS + AI agents. All routes are versioned under /api/v1 and tenant-scoped via Row-Level Security.",
        version: "0.1.0",
      },
      servers: [{ url: "/", description: "current host" }],
      components: {
        securitySchemes: {
          // Production: Clerk-issued session JWT (Bearer).
          clerkBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Clerk session token. Used in production.",
          },
          // Dev-only convenience: X-Org-Id header (NODE_ENV !== production).
          devOrgId: {
            type: "apiKey",
            in: "header",
            name: "X-Org-Id",
            description: "DEV ONLY: organisation UUID. Ignored in production.",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });
};

export default fp(swaggerPlugin, { name: "swagger" });
