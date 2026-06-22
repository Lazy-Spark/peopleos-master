import {
  AddToPoolResponse,
  AnalyzeLinkedInResponse,
  ApiError,
  type AddToPoolResponse as AddToPoolResponseT,
  type AnalyzeLinkedInResponse as AnalyzeLinkedInResponseT,
  type CandidateSource as CandidateSourceT,
  type LinkedInScrapedProfile as LinkedInScrapedProfileT,
} from "@peopleos/schemas";
import { z } from "zod";
import { loadSettings, type ExtensionSettings } from "./lib/settings.js";

/**
 * Typed fetch client for the PeopleOS Fastify API (`/api/v1/copilot/linkedin/*`).
 *
 * Mirrors apps/web/lib/api.ts: responses are validated against the FROZEN
 * @peopleos/schemas Zod contracts — we never redeclare wire shapes here.
 *
 * ── Auth ──────────────────────────────────────────────────────────────────────
 * DEV   : send `X-Org-Id: <devOrgId>` so the API resolves the tenant for RLS without
 *         a Clerk session (only honoured when the API has no Clerk secret configured).
 * PROD  : the org is derived server-side from a verified Clerk session. The extension
 *         must then send `Authorization: Bearer <clerk session jwt>` and the API
 *         ignores X-Org-Id.
 *         TODO(prod-auth): obtain the Clerk session JWT in the extension — e.g. open a
 *         hosted PeopleOS sign-in tab and read the short-lived token via a postMessage
 *         bridge or chrome.identity launchWebAuthFlow, then store it as
 *         settings.authToken and refresh on 401. Until then prod auth is a no-op and
 *         the extension is dev-only.
 *
 * ── Request bodies (FROZEN contracts) ────────────────────────────────────────
 *   analyze     : the API expects { orgId, profile, consent: true, roles[] }. The
 *                 extension cannot know orgId (server-trusted) or the org's open roles
 *                 (DB-only), so it sends just { profile, consent: true }; the API fills
 *                 orgId from auth and roles from the DB before calling the AI service.
 *   add-to-pool : { profile, consent: true, source } — orgId is server-derived.
 */

/** Non-2xx response carrying the parsed API error envelope. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Thrown before any network call when the extension has not been configured yet. */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  settings?: ExtensionSettings,
): Promise<T> {
  const cfg = settings ?? (await loadSettings());

  if (!cfg.apiBaseUrl) {
    throw new NotConfiguredError("Set the PeopleOS API base URL in the extension options.");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  // Prod auth (preferred when present): Clerk session bearer token.
  if (cfg.authToken) {
    headers["Authorization"] = `Bearer ${cfg.authToken}`;
  }
  // Dev tenant resolution: X-Org-Id. Harmless in prod (the API ignores it there).
  if (cfg.devOrgId) {
    headers["X-Org-Id"] = cfg.devOrgId;
  }

  if (!cfg.authToken && !cfg.devOrgId) {
    throw new NotConfiguredError(
      "No auth configured. Set a dev org id (dev) or a Clerk token (prod) in options.",
    );
  }

  const res = await fetch(`${cfg.apiBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // The API is the auth/tenant boundary; never cache tenant data.
    cache: "no-store",
  });

  const text = await res.text();
  const json: unknown = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const parsed = ApiError.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiClientError(res.status, code, message, details);
    }
    throw new ApiClientError(
      res.status,
      "UNKNOWN",
      `Request to ${path} failed with status ${res.status}`,
      json,
    );
  }

  return schema.parse(json);
}

export const copilotApi = {
  /**
   * POST /api/v1/copilot/linkedin/analyze — analyse a (consented) scraped profile
   * against the org's open roles. The API enriches the body with orgId + roles.
   */
  analyzeLinkedIn(
    profile: LinkedInScrapedProfileT,
    settings?: ExtensionSettings,
  ): Promise<AnalyzeLinkedInResponseT> {
    return request(
      "/api/v1/copilot/linkedin/analyze",
      AnalyzeLinkedInResponse,
      { profile, consent: true },
      settings,
    );
  },

  /**
   * POST /api/v1/copilot/linkedin/add-to-pool — create a Candidate from a scraped
   * profile (consent required by the frozen AddToPoolRequest: consent is z.literal(true)).
   */
  addToPool(
    profile: LinkedInScrapedProfileT,
    source: CandidateSourceT = "LINKEDIN",
    settings?: ExtensionSettings,
  ): Promise<AddToPoolResponseT> {
    return request(
      "/api/v1/copilot/linkedin/add-to-pool",
      AddToPoolResponse,
      { profile, consent: true, source },
      settings,
    );
  },
};
