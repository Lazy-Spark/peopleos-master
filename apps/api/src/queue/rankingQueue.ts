import { Queue } from "bullmq";
import { z } from "zod";
import { queueConnection } from "./connection.js";

/**
 * BullMQ queue for the Module 1 auto-trigger: when a candidate applies for a job,
 * the application-create route enqueues a job here and the worker (src/worker.ts)
 * runs the resume-screening pipeline (rankApplication) asynchronously, so the
 * applicant's POST returns immediately and the (up to ~8s/candidate) AI scoring
 * happens off the request path (spec Module 1 trigger: "new candidate applies").
 */
export const RANKING_QUEUE_NAME = "ranking";

/**
 * Payload of a ranking job. Validated on both ends: the producer parses before
 * enqueue (never push a malformed job) and the worker parses on receive (never
 * trust the queue blindly). orgId scopes the worker's withTenant() RLS context.
 */
export const RankingJobData = z.object({
  orgId: z.string().uuid(),
  applicationId: z.string().uuid(),
});
export type RankingJobData = z.infer<typeof RankingJobData>;

/** The shared queue handle (producer side). The worker creates its own Worker. */
export const rankingQueue = new Queue<RankingJobData>(RANKING_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    // Auto-trigger scoring is best-effort: a transient AI/DB blip should retry with
    // backoff, but we keep attempts small (the recruiter can always re-rank by hand
    // via POST /applications/:id/rank). A `skipped` result is NOT a failure — the
    // worker returns normally for it, so it is never retried (see worker.ts).
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  },
});

/**
 * Enqueue a ranking job. Validates the payload first. The unique jobId
 * (`rank:{applicationId}`) de-duplicates repeated enqueues for the same
 * application (e.g. a retried create) into a single queued job.
 */
export async function enqueueRanking(data: RankingJobData): Promise<void> {
  const parsed = RankingJobData.parse(data);
  await rankingQueue.add("rank-application", parsed, {
    jobId: `rank:${parsed.applicationId}`,
  });
}
