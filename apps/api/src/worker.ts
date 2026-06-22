import { Worker, type Job } from "bullmq";
import pino from "pino";
import { env, isProduction } from "./env.js";
import { prisma } from "./db.js";
import { RankingNotFoundError, rankApplication } from "./services/ranking.js";
import { closeQueueConnection, queueConnection } from "./queue/connection.js";
import { RANKING_QUEUE_NAME, RankingJobData } from "./queue/rankingQueue.js";
import { closeRetentionPurge, purgeExpiredTranscripts } from "./jobs/retentionPurge.js";
import { closeWorkflowTick, workflowTick } from "./jobs/workflowTick.js";

/**
 * BullMQ worker process for the Module 1 ranking auto-trigger.
 *
 * Consumes the `ranking` queue (jobs enqueued by POST /applications) and runs the
 * shared `rankApplication` pipeline for each. Run alongside the API as a SEPARATE
 * process (`pnpm --filter @peopleos/api worker`) so AI scoring never blocks the
 * HTTP request path.
 *
 * Retry semantics:
 *   - A `skipped` result (candidate has no parsed profile yet) is NOT an error: the
 *     resume pipeline simply has not run. We log it and RETURN NORMALLY so BullMQ
 *     marks the job complete and never retries it.
 *   - A missing application (RankingNotFoundError) — e.g. deleted between enqueue
 *     and processing — is also non-retryable; we log and return normally.
 *   - Any OTHER error (AI service 502/timeout, DB blip) THROWS, so BullMQ retries
 *     with the queue's exponential backoff (attempts: 3).
 */

const log = pino({
  level: env.LOG_LEVEL,
  ...(isProduction ? {} : { transport: { target: "pino-pretty" } }),
});

/** Bounded concurrency: process a few applications in parallel per worker. */
const WORKER_CONCURRENCY = 5;

const worker = new Worker<RankingJobData>(
  RANKING_QUEUE_NAME,
  async (job: Job<RankingJobData>) => {
    // Never trust the queue payload blindly — validate against the contract.
    const { orgId, applicationId } = RankingJobData.parse(job.data);

    try {
      const result = await rankApplication(orgId, applicationId, {
        // System-triggered: no human actor. The audit entry records the scoring
        // decision with a null actorId (a system action).
        actorId: null,
      });

      if (result.status === "skipped") {
        // Expected, non-retryable: profile not parsed yet. Return normally.
        log.info(
          { jobId: job.id, orgId, applicationId, candidateId: result.candidateId, reason: result.reason },
          "ranking auto-trigger skipped (no parsed profile)",
        );
        return { status: "skipped" as const, candidateId: result.candidateId };
      }

      log.info(
        {
          jobId: job.id,
          orgId,
          applicationId,
          candidateId: result.ranking.candidateId,
          tier: result.ranking.tier,
          finalScore: result.ranking.finalScore,
        },
        "ranking auto-trigger completed",
      );
      return { status: "ranked" as const, tier: result.ranking.tier };
    } catch (err) {
      // A vanished application is non-retryable — log and complete the job.
      if (err instanceof RankingNotFoundError) {
        log.warn({ jobId: job.id, orgId, applicationId, err: err.message }, "ranking auto-trigger target missing");
        return { status: "missing" as const };
      }
      // Everything else (AI 502/timeout, transient DB error) is retryable — rethrow.
      throw err;
    }
  },
  {
    connection: queueConnection,
    concurrency: WORKER_CONCURRENCY,
  },
);

worker.on("failed", (job, err) => {
  log.error(
    { jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message },
    "ranking job failed",
  );
});

worker.on("error", (err) => {
  log.error({ err: err.message }, "ranking worker error");
});

worker.on("ready", () => {
  log.info({ queue: RANKING_QUEUE_NAME, concurrency: WORKER_CONCURRENCY }, "ranking worker ready");
});

/**
 * Transcript retention sweep (Module 3, spec Privacy): periodically purge interview
 * transcripts past their retention window (default 90d), running the SAME erasure as a
 * DSAR delete (remove the S3 object + clear the transcript-derived AI-draft quotes). Run
 * here via a simple interval; a multi-instance deployment should prefer a single BullMQ
 * repeatable job / external cron so only one instance sweeps. No-ops without the owner
 * DATABASE_URL. unref() so the timer never keeps the process alive on its own.
 */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const retentionTimer = setInterval(() => {
  void purgeExpiredTranscripts().catch((err) =>
    log.error({ err: err instanceof Error ? err.message : String(err) }, "retention sweep tick failed"),
  );
}, RETENTION_SWEEP_INTERVAL_MS);
retentionTimer.unref?.();
// Run once shortly after startup so a freshly-started worker catches up on a backlog.
void purgeExpiredTranscripts().catch((err) =>
  log.error({ err: err instanceof Error ? err.message : String(err) }, "initial retention sweep failed"),
);

/**
 * Workflow engine tick (Module 9): the dev engine's periodic, owner-level sweep across
 * orgs. Each tick fires due TIMER tasks, escalates breached SLAs, and starts due
 * SCHEDULED definitions (see jobs/workflowTick.ts). Like the retention sweep it runs via
 * a simple interval here; a multi-instance deployment should prefer a single BullMQ
 * repeatable job so only one instance sweeps, and PROD replaces this entirely with
 * Temporal's durable timers (documented in workflowTick.ts / workflowEngine.ts). No-ops
 * without the owner DATABASE_URL. unref() so the timer never keeps the process alive.
 */
const WORKFLOW_TICK_INTERVAL_MS = 60 * 1000; // every minute (timers/SLA are minute-grained)
const workflowTimer = setInterval(() => {
  void workflowTick().catch((err) =>
    log.error({ err: err instanceof Error ? err.message : String(err) }, "workflow tick failed"),
  );
}, WORKFLOW_TICK_INTERVAL_MS);
workflowTimer.unref?.();
// Run once shortly after startup so a freshly-started worker catches up on a backlog.
void workflowTick().catch((err) =>
  log.error({ err: err instanceof Error ? err.message : String(err) }, "initial workflow tick failed"),
);

/**
 * Graceful shutdown: stop accepting new jobs, let in-flight jobs finish, then
 * release the Redis connection and the Prisma pool. Important for rolling deploys
 * (spec Infrastructure: ECS/Fargate) so a job is never abandoned mid-flight.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "ranking worker shutting down");
  try {
    clearInterval(retentionTimer);
    clearInterval(workflowTimer);
    await worker.close(); // waits for active jobs to complete
    await closeQueueConnection();
    await closeRetentionPurge();
    await closeWorkflowTick();
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    log.error({ err }, "error during worker shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
