import { copilotApi, ApiClientError, NotConfiguredError } from "../api.js";
import { isRuntimeMessage, type RuntimeMessage } from "../lib/messages.js";

/**
 * Background service worker (MV3).
 *
 * - Opens the side panel when the toolbar action is clicked.
 * - Receives the consented SCRAPED_PROFILE from the content script, calls the PeopleOS
 *   API (POST /api/v1/copilot/linkedin/analyze with { profile, consent: true }), and
 *   pushes the validated result to the side panel.
 * - Handles ADD_TO_POOL commands from the side panel.
 *
 * The worker NEVER initiates a scrape on its own — it only reacts to a SCRAPED_PROFILE
 * that the content script produced behind the user's explicit consent click.
 */

/** Open the side panel on this tab (must run within the action's user gesture). */
async function openPanel(tabId: number): Promise<void> {
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "src/sidepanel/index.html",
      enabled: true,
    });
    await chrome.sidePanel.open({ tabId });
  } catch (err) {
    // open() throws outside a user gesture; the panel can also be opened from the
    // toolbar directly, so this is non-fatal.
    console.debug("[peopleos] sidePanel.open skipped:", err);
  }
}

// Open the panel when the toolbar icon is clicked.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void openPanel(tab.id);
});

// Allow opening the panel by clicking the action while on any tab.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.debug("[peopleos] setPanelBehavior:", err));
});

/** Push a message to the side panel (and any other extension page that is open). */
function pushToPanel(message: RuntimeMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // No receiver (panel closed) — safe to ignore.
  });
}

function describeError(err: unknown): string {
  if (err instanceof NotConfiguredError) return err.message;
  if (err instanceof ApiClientError) {
    return `${err.message} (${err.code}, HTTP ${String(err.status)})`;
  }
  if (err instanceof Error) return err.message;
  return "Unexpected error.";
}

async function handleAnalyze(message: Extract<RuntimeMessage, { type: "SCRAPED_PROFILE" }>): Promise<void> {
  pushToPanel({ type: "ANALYSIS_STARTED", profile: message.profile });
  try {
    const result = await copilotApi.analyzeLinkedIn(message.profile);
    pushToPanel({ type: "ANALYSIS_RESULT", result, profile: message.profile });
  } catch (err) {
    pushToPanel({ type: "ERROR", scope: "analyze", message: describeError(err) });
  }
}

async function handleAddToPool(
  message: Extract<RuntimeMessage, { type: "ADD_TO_POOL" }>,
): Promise<void> {
  try {
    const result = await copilotApi.addToPool(message.profile);
    pushToPanel({ type: "ADDED_TO_POOL", result });
  } catch (err) {
    pushToPanel({ type: "ERROR", scope: "add-to-pool", message: describeError(err) });
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
  if (!isRuntimeMessage(raw)) return;

  switch (raw.type) {
    case "SCRAPED_PROFILE":
      void handleAnalyze(raw);
      break;
    case "SCRAPE_FAILED":
      pushToPanel({ type: "ERROR", scope: "scrape", message: raw.reason });
      break;
    case "ADD_TO_POOL":
      void handleAddToPool(raw);
      break;
    case "PAGE_CONTEXT":
      // Open the panel when the content-script consent button is clicked, then
      // forward the context so the panel header can update.
      if (sender.tab?.id !== undefined) void openPanel(sender.tab.id);
      pushToPanel(raw);
      break;
    case "ANALYZE":
      // Panel asked to (re)analyse the active tab: forward a scrape request whose
      // origin is the user's click in the panel (consent preserved).
      chrome.tabs.sendMessage(raw.tabId, { type: "REQUEST_SCRAPE" }).catch(() => {
        pushToPanel({
          type: "ERROR",
          scope: "scrape",
          message: "Could not reach the LinkedIn tab. Reload the profile page and retry.",
        });
      });
      break;
    default:
      // Other message types are panel-bound pushes; ignore here.
      break;
  }
});
