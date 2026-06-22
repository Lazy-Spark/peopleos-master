import { Redis, type RedisOptions } from "ioredis";
import { env } from "../env.js";

/**
 * Shared ioredis connection for BullMQ (spec Backend: BullMQ + Redis for async AI).
 *
 * BullMQ REQUIRES `maxRetriesPerRequest: null` (and disables the per-command retry
 * cap) on the connection it uses for blocking commands — otherwise long-lived
 * blocking reads (BRPOPLPUSH) error out. We set it here once and reuse the same
 * client for both the producer (Queue) and the consumer (Worker), so there is a
 * single connection pool to manage and to close on shutdown.
 */
const redisOptions: RedisOptions = {
  // Required by BullMQ for blocking operations.
  maxRetriesPerRequest: null,
  // Connect lazily so importing the module (e.g. in the API process that only
  // produces) does not force a connection before the queue is actually used.
  lazyConnect: true,
};

export const queueConnection = new Redis(env.REDIS_URL, redisOptions);

/** Gracefully close the shared Redis connection (called from worker shutdown). */
export async function closeQueueConnection(): Promise<void> {
  if (queueConnection.status !== "end") {
    await queueConnection.quit();
  }
}
