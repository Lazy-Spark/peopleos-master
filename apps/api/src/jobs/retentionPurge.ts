import { Prisma, PrismaClient } from "@prisma/client";
import pino from "pino";
import { env, isProduction } from "../env.js";
import { transcriptStore } from "../lib/transcriptStore.js";

/**
 * Transcript retention sweep (spec Module 3 Privacy: "Transcripts deleted per
 * org-configured retention, default 90 days").
 *
 * This is a CROSS-ORG maintenance job, so it connects as the OWNER role (DATABASE_URL),
 * which BYPASSES Row-Level Security — like migrations/seed — because no single tenant
 * context can see every org's expired interviews. It must NEVER serve request traffic.
 * The erasure is identical to the DSAR delete: remove the encrypted S3 object, null the
 * transcript path + mark DELETED, AND clear the transcript-DERIVED text (the AI scorecard
 * draft's verbatim evidence quotes + summary) so no excerpt of an expired transcript
 * survives anywhere. When DATABASE_URL is unset the sweep logs and no-ops.
 */

const log = pino({
  level: env.LOG_LEVEL,
  ...(isProduction ? {} : { transport: { target: "pino-pretty" } }),
});

/** Max interviews purged per tick (bounded so a backlog cannot stall the worker). */
const PURGE_BATCH = 500;

let ownerClient: PrismaClient | null = null;
function ownerDb(): PrismaClient | null {
  if (!env.DATABASE_URL) return null;
  ownerClient ??= new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  return ownerClient;
}

export async function purgeExpiredTranscripts(now: Date = new Date()): Promise<{ purged: number }> {
  const db = ownerDb();
  if (!db) {
    log.warn("retention sweep skipped: owner DATABASE_URL is not configured");
    return { purged: 0 };
  }

  const due = await db.interview.findMany({
    where: {
      transcriptRetentionDeleteAt: { lte: now },
      transcriptStatus: { not: "DELETED" },
      transcriptPath: { not: null },
    },
    select: { id: true, orgId: true },
    take: PURGE_BATCH,
  });

  let purged = 0;
  for (const iv of due) {
    try {
      // Delete the S3 object first (idempotent) so we never mark DELETED while it lingers.
      await transcriptStore.delete(iv.orgId, iv.id);
      await db.$transaction(async (tx) => {
        await tx.interview.update({
          where: { id: iv.id },
          data: {
            transcriptPath: null,
            transcriptStatus: "DELETED",
            transcriptDeletedAt: now,
          },
        });
        // Erase transcript-DERIVED text too — the same guarantee the DSAR delete makes.
        await tx.scorecard.updateMany({
          where: { interviewId: iv.id },
          data: { aiScorecardDraft: Prisma.DbNull, aiSummary: null },
        });
        await tx.auditLog.create({
          data: {
            orgId: iv.orgId,
            actorId: null,
            action: "interview.transcript.purge",
            entityType: "interview",
            entityId: iv.id,
            payload: { reason: "retention" },
          },
        });
      });
      purged += 1;
    } catch (err) {
      log.error(
        { interviewId: iv.id, orgId: iv.orgId, err: err instanceof Error ? err.message : String(err) },
        "retention sweep failed for interview",
      );
    }
  }
  if (purged > 0) log.info({ purged, scanned: due.length }, "retention sweep completed");
  return { purged };
}

/** Release the owner Prisma pool (called on worker shutdown). */
export async function closeRetentionPurge(): Promise<void> {
  if (ownerClient) {
    await ownerClient.$disconnect();
    ownerClient = null;
  }
}
