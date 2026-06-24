import { z } from "zod";

/**
 * Zod-validated view of process.env. The app must fail fast at boot if a required
 * variable is missing or malformed, rather than discovering it mid-request.
 *
 * Variable names mirror .env.example exactly. The API connects to Postgres as the
 * RLS-subject role via DATABASE_URL_APP (NOT the owner DATABASE_URL — the owner
 * bypasses RLS and must never serve traffic).
 */
const EnvSchema = z.object({
  // ── Runtime ────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // ── HTTP listener ────────────────────────────────────────────────────────────
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // ── CORS ─────────────────────────────────────────────────────────────────────
  // Comma-separated list of allowed web origins (e.g. the deployed web app URL). The
  // web app calls this API cross-origin, so the browser needs CORS headers. When UNSET,
  // any origin is reflected (handy for local/demo); set it to lock down in production.
  CORS_ORIGINS: z.string().optional(),

  // ── Datastore (RLS-subject app role) ─────────────────────────────────────────
  // The API is SUBJECT to Row-Level Security; it must use the peopleos_app role.
  DATABASE_URL_APP: z.string().url(),
  // The OWNER connection (BYPASSES RLS). NOT used to serve request traffic — only the
  // cross-org transcript retention sweep (jobs/retentionPurge.ts) uses it, since no
  // single tenant context can see every org's expired interviews. Optional: when unset,
  // the retention sweep logs and no-ops.
  DATABASE_URL: z.string().url().optional(),

  // ── Redis (BullMQ queues — async AI auto-trigger; spec Backend job queues) ───
  REDIS_URL: z.string().url(),

  // ── AI service (Python FastAPI) ──────────────────────────────────────────────
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),

  // ── Internal tool router shared secret ───────────────────────────────────────
  // The AI service (Module 2c ReAct agent) calls back into the API's
  // /internal/copilot/* tool endpoints over the internal network. Those routes are
  // OUTSIDE Clerk/tenancy, so they are guarded by a constant-time check of the
  // `x-internal-secret` header against this value. Required in production (like
  // CLERK_SECRET_KEY); when UNSET, the internal router refuses ALL calls (fail-closed).
  AI_SERVICE_SECRET: z.string().optional(),

  // ── Clerk auth ───────────────────────────────────────────────────────────────
  // Required in production; optional in dev/test where the X-Org-Id fallback applies.
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),

  // ── S3 transcript store (Module 3 — Interview Intelligence) ──────────────────
  // Interview transcripts are highly sensitive: they live ONLY in S3, encrypted at
  // rest (SSE-KMS in prod, AES-256 in dev/MinIO), NEVER in a plaintext DB column.
  // The DB stores only the object key + governance metadata (consent/retention).
  S3_BUCKET: z.string().min(1).default("peopleos-dev"),
  S3_REGION: z.string().min(1).default("us-east-1"),
  // Custom endpoint for an S3-compatible store (MinIO in dev). Unset → real AWS S3.
  S3_ENDPOINT: z.string().url().optional(),
  // Customer-managed KMS key for SSE-KMS encryption of transcripts (spec: S3 SSE-KMS).
  // Optional: when unset in prod the bucket's default KMS key is used (aws:kms).
  S3_KMS_KEY_ID: z.string().optional(),
  // AWS credentials. Optional in dev (MinIO defaults / explicit creds) and in prod
  // (the ECS task IAM role supplies them via the ambient provider chain).
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse once at module load. In production, a missing CLERK_SECRET_KEY is fatal
 * because the auth plugin will not start without a real verifier.
 */
function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;
  if (env.NODE_ENV === "production" && !env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY is required when NODE_ENV=production");
  }
  // The internal tool router (AI service → /internal/copilot/*) authenticates with a
  // shared secret. In production it MUST be set; without it the router fails closed
  // and the Module 2c chat agent's tools would be unusable, so fail fast at boot.
  if (env.NODE_ENV === "production" && !env.AI_SERVICE_SECRET) {
    throw new Error("AI_SERVICE_SECRET is required when NODE_ENV=production");
  }
  return env;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
