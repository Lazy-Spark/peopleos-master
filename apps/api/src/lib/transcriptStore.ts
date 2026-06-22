import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { InterviewTranscript, type InterviewTranscript as TInterviewTranscript } from "@peopleos/schemas";
import { env, isProduction } from "../env.js";

/**
 * Encrypted object store for interview transcripts (Module 3 — Privacy is central).
 *
 * Interview transcripts are HIGHLY sensitive. They are NEVER persisted to a plaintext
 * database column; they live only in S3 with server-side encryption (SSE-KMS in prod,
 * AES-256 SSE-S3 in dev/MinIO where a KMS key may be absent). The DB stores only the
 * object key (`Interview.transcriptPath`) plus governance metadata (consent, status,
 * retention/deletion timestamps).
 *
 * Keying: `transcripts/{orgId}/{interviewId}.json`. The orgId prefix keeps every
 * tenant's transcripts under a distinct path so bucket policies / lifecycle rules can
 * be scoped per tenant, and so a DSAR delete targets exactly one object.
 */

/** Build the deterministic object key for an interview's transcript. */
export function transcriptKey(orgId: string, interviewId: string): string {
  return `transcripts/${orgId}/${interviewId}.json`;
}

/**
 * Lazily-constructed S3 client. We build it once and reuse it. In dev the
 * `S3_ENDPOINT` points at MinIO (path-style addressing required); in prod the SDK
 * resolves the AWS endpoint from the region. Credentials are taken from the standard
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env (optional in dev — MinIO defaults),
 * or the ambient provider chain (IAM role) when unset in prod.
 */
let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  const credentials =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined; // fall back to the AWS provider chain (IAM role in prod)

  client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(credentials ? { credentials } : {}),
  });
  return client;
}

/**
 * The server-side encryption to apply on PUT. Transcripts are NEVER stored
 * unencrypted: in production we require SSE-KMS (spec: S3 SSE-KMS, customer-managed
 * key); in dev/MinIO we fall back to AES-256 (SSE-S3) since a KMS key is typically
 * unavailable locally. Either way the object is encrypted at rest.
 */
function encryptionParams(): {
  ServerSideEncryption: ServerSideEncryption;
  SSEKMSKeyId?: string;
} {
  if (isProduction || env.S3_KMS_KEY_ID) {
    return { ServerSideEncryption: "aws:kms", ...(env.S3_KMS_KEY_ID ? { SSEKMSKeyId: env.S3_KMS_KEY_ID } : {}) };
  }
  return { ServerSideEncryption: "AES256" };
}

async function streamToString(body: unknown): Promise<string> {
  // The AWS SDK v3 GetObject Body is a Node Readable in this runtime. Read it fully.
  if (body && typeof (body as { transformToString?: unknown }).transformToString === "function") {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Thrown when the object store is unreachable or returns an unexpected error. The
 * route layer maps this to a clean 502, never leaking S3 internals to the client.
 */
export class TranscriptStoreError extends Error {
  readonly code = "TRANSCRIPT_STORE_ERROR";
  readonly status = 502;
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "TranscriptStoreError";
    this.details = details;
  }
}

export const transcriptStore = {
  /**
   * Encrypt-and-store a transcript JSON for an interview. The body is validated
   * against the frozen `InterviewTranscript` contract before it is written, so a
   * malformed object can never land in the store. Returns the object key persisted
   * to `Interview.transcriptPath`.
   */
  async put(
    orgId: string,
    interviewId: string,
    transcript: TInterviewTranscript,
  ): Promise<string> {
    const valid = InterviewTranscript.parse(transcript);
    const Key = transcriptKey(orgId, interviewId);
    try {
      await getClient().send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key,
          Body: JSON.stringify(valid),
          ContentType: "application/json",
          ...encryptionParams(),
        }),
      );
    } catch (err) {
      throw new TranscriptStoreError(
        `Failed to store transcript for interview ${interviewId}`,
        err instanceof Error ? err.message : undefined,
      );
    }
    return Key;
  },

  /**
   * Fetch + validate a stored transcript. Returns null if the object is absent
   * (NoSuchKey) — callers treat that as "no transcript" (409/404 at the route).
   */
  async get(orgId: string, interviewId: string): Promise<TInterviewTranscript | null> {
    const Key = transcriptKey(orgId, interviewId);
    let text: string;
    try {
      const res = await getClient().send(
        new GetObjectCommand({ Bucket: env.S3_BUCKET, Key }),
      );
      if (!res.Body) return null;
      text = await streamToString(res.Body);
    } catch (err) {
      // A missing object is an expected, non-error condition.
      if (isNoSuchKey(err)) return null;
      throw new TranscriptStoreError(
        `Failed to load transcript for interview ${interviewId}`,
        err instanceof Error ? err.message : undefined,
      );
    }
    try {
      return InterviewTranscript.parse(JSON.parse(text));
    } catch (err) {
      throw new TranscriptStoreError(
        `Stored transcript for interview ${interviewId} failed contract validation`,
        err instanceof Error ? err.message : undefined,
      );
    }
  },

  /**
   * Delete a transcript object (DSAR / retention). Idempotent: deleting an absent
   * object is a no-op success (S3 DeleteObject is already idempotent; NoSuchKey is
   * also swallowed defensively).
   */
  async delete(orgId: string, interviewId: string): Promise<void> {
    const Key = transcriptKey(orgId, interviewId);
    try {
      await getClient().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key }));
    } catch (err) {
      if (isNoSuchKey(err)) return;
      throw new TranscriptStoreError(
        `Failed to delete transcript for interview ${interviewId}`,
        err instanceof Error ? err.message : undefined,
      );
    }
  },
};

/** Detect the S3 "object does not exist" error across SDK error shapes. */
function isNoSuchKey(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: string; Code?: string }).name;
  const code = (err as { Code?: string }).Code;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NoSuchKey" || code === "NoSuchKey" || status === 404;
}

export type TranscriptStore = typeof transcriptStore;
