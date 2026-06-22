import {
  isRuntimeMessage,
  type LinkedInPageKind,
  type PageContext,
  type RuntimeMessage,
} from "../lib/messages.js";
import { scrapeProfile } from "./scrape.js";

/**
 * Content script (injected on linkedin.com/in/* and linkedin.com/jobs/*).
 *
 * Responsibilities:
 *  1. Detect the page kind (profile | job | other) and report it to the panel.
 *  2. Inject an explicit, clearly-labelled consent control:
 *        "Analyze with PeopleOS (consent)"
 *  3. ONLY when that control (or an equivalent panel-initiated REQUEST_SCRAPE that is
 *     itself triggered by a user click in the panel) fires, scrape the visible profile
 *     and send it to the background worker.
 *
 * No scraping or network activity happens on injection — the script is dormant until
 * the user gives consent. This satisfies the spec requirement "with consent".
 */

const CONSENT_BUTTON_ID = "peopleos-consent-btn";

function detectPageKind(): LinkedInPageKind {
  const path = window.location.pathname;
  if (path.startsWith("/in/")) return "profile";
  if (path.startsWith("/jobs/")) return "job";
  return "other";
}

function currentContext(): PageContext {
  const kind = detectPageKind();
  const heading = document.querySelector("main h1")?.textContent?.trim() ?? null;
  return {
    kind,
    url: `${window.location.origin}${window.location.pathname}`,
    label: heading,
  };
}

/** Fire-and-forget message to the background worker (worker may be asleep). */
function notifyBackground(message: RuntimeMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // No receiver (worker spinning up) — the worker re-reads on its own; safe to ignore.
  });
}

/** Perform the consented scrape and forward to the background worker. */
function consentedScrape(): void {
  try {
    const profile = scrapeProfile();
    notifyBackground({ type: "SCRAPED_PROFILE", profile });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Could not read this profile page.";
    notifyBackground({ type: "SCRAPE_FAILED", reason });
  }
}

/**
 * Inject a floating consent button on profile pages. Clicking it is the user's
 * explicit consent gesture; it also opens the side panel via the background worker.
 */
function injectConsentButton(): void {
  if (detectPageKind() !== "profile") return;
  if (document.getElementById(CONSENT_BUTTON_ID)) return;

  const btn = document.createElement("button");
  btn.id = CONSENT_BUTTON_ID;
  btn.type = "button";
  btn.textContent = "Analyze with PeopleOS (consent)";
  btn.setAttribute("aria-label", "Analyze this LinkedIn profile with PeopleOS. Clicking grants consent to read the visible profile.");
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "99999",
    padding: "10px 16px",
    background: "#0a66c2",
    color: "#fff",
    border: "none",
    borderRadius: "999px",
    font: "600 13px/1.2 system-ui, -apple-system, sans-serif",
    boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);

  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Analyzing…";
    // Ask the background worker to open the side panel (must be in a user gesture),
    // then perform the consented scrape and hand the profile off for analysis.
    notifyBackground({ type: "PAGE_CONTEXT", context: currentContext() });
    consentedScrape();
    // Re-enable shortly so the recruiter can re-run after navigating.
    window.setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "Analyze with PeopleOS (consent)";
    }, 2500);
  });

  document.body.appendChild(btn);
}

// Listen for panel/background-initiated requests. A REQUEST_SCRAPE only ever originates
// from a user click in the side panel, so honouring it preserves the consent invariant.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) return;
  if (message.type === "GET_PAGE_CONTEXT") {
    sendResponse(currentContext());
    return;
  }
  if (message.type === "REQUEST_SCRAPE") {
    consentedScrape();
    sendResponse({ ok: true });
    return;
  }
});

// LinkedIn is a SPA: re-inject the button on client-side navigations.
let lastPath = window.location.pathname;
const observer = new MutationObserver(() => {
  if (window.location.pathname !== lastPath) {
    lastPath = window.location.pathname;
    injectConsentButton();
    notifyBackground({ type: "PAGE_CONTEXT", context: currentContext() });
  }
});
observer.observe(document.body, { childList: true, subtree: true });

injectConsentButton();
