import { buildApp } from "./app.js";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { closeChatMemory } from "./lib/chatMemory.js";

/**
 * Process entrypoint: build the app and start listening on API_HOST/API_PORT.
 *
 * Handles graceful shutdown on SIGINT/SIGTERM (close the HTTP server, then the
 * Prisma connection pool + the Module 4 chat-memory Redis connection) so in-flight
 * requests drain and connections are released — important for rolling deploys on
 * ECS/Fargate (spec Infrastructure).
 */
async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await Promise.allSettled([prisma.$disconnect(), closeChatMemory()]);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
    app.log.info(
      `PeopleOS API listening on http://${env.API_HOST}:${env.API_PORT} (docs at /docs)`,
    );
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    await prisma.$disconnect();
    process.exit(1);
  }
}

void main();
