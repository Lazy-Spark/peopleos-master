import type {
  AddToPoolResponse,
  AnalyzeLinkedInResponse,
  LinkedInScrapedProfile,
} from "@peopleos/schemas";

/**
 * Typed message bus for the extension. Three contexts exchange messages:
 *
 *   content script  ──(SCRAPED_PROFILE)──▶  background worker  ──API──▶  PeopleOS
 *   side panel       ──(REQUEST_SCRAPE)──▶  background worker  ──▶ content script
 *   background       ──(ANALYSIS_RESULT / ERROR)──▶  side panel
 *
 * Consent invariant: a SCRAPED_PROFILE message is ONLY ever produced by the content
 * script after the user clicks the in-page "Analyze with PeopleOS (consent)" control.
 * The background worker forwards it to the API with `consent: true`. There is no code
 * path that scrapes or transmits a profile without that explicit gesture.
 */

/** What kind of LinkedIn page the content script detected. */
export type LinkedInPageKind = "profile" | "job" | "other";

export interface PageContext {
  kind: LinkedInPageKind;
  url: string;
  /** A short human label for the panel header (e.g. the profile name if visible). */
  label: string | null;
}

// ── Messages FROM the side panel / background → content script ────────────────
export interface RequestScrapeMessage {
  type: "REQUEST_SCRAPE";
}

export interface GetPageContextMessage {
  type: "GET_PAGE_CONTEXT";
}

// ── Messages FROM the content script → background ─────────────────────────────
export interface ScrapedProfileMessage {
  type: "SCRAPED_PROFILE";
  /** Always gathered behind an explicit user consent click in the page. */
  profile: LinkedInScrapedProfile;
}

export interface ScrapeFailedMessage {
  type: "SCRAPE_FAILED";
  reason: string;
}

export interface PageContextMessage {
  type: "PAGE_CONTEXT";
  context: PageContext;
}

// ── Messages FROM background → side panel (push) ──────────────────────────────
export interface AnalysisStartedMessage {
  type: "ANALYSIS_STARTED";
  profile: LinkedInScrapedProfile;
}

export interface AnalysisResultMessage {
  type: "ANALYSIS_RESULT";
  result: AnalyzeLinkedInResponse;
  profile: LinkedInScrapedProfile;
}

export interface AddedToPoolMessage {
  type: "ADDED_TO_POOL";
  result: AddToPoolResponse;
}

export interface ErrorMessage {
  type: "ERROR";
  scope: "analyze" | "add-to-pool" | "scrape";
  message: string;
}

// ── Messages FROM side panel → background (commands) ──────────────────────────
export interface AnalyzeCommand {
  type: "ANALYZE";
  /** The tab whose content script should perform the consented scrape. */
  tabId: number;
}

export interface AddToPoolCommand {
  type: "ADD_TO_POOL";
  profile: LinkedInScrapedProfile;
}

export type RuntimeMessage =
  | RequestScrapeMessage
  | GetPageContextMessage
  | ScrapedProfileMessage
  | ScrapeFailedMessage
  | PageContextMessage
  | AnalysisStartedMessage
  | AnalysisResultMessage
  | AddedToPoolMessage
  | ErrorMessage
  | AnalyzeCommand
  | AddToPoolCommand;

/** Narrowing helper used by every listener (no `any`). */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
