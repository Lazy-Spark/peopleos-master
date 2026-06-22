/**
 * Extension settings, persisted in chrome.storage.sync (so they follow the
 * recruiter across machines). Set from the options page.
 *
 * AUTH MODEL (mirrors apps/web/lib/api.ts + apps/api auth plugin):
 *  - DEV: the API trusts an `X-Org-Id` header when Clerk is not configured
 *    (NODE_ENV !== "production"). The recruiter pastes a seed org UUID here.
 *  - PROD: the org is derived server-side from a verified Clerk session, so the
 *    extension must send a Clerk session JWT as `Authorization: Bearer <token>`
 *    and the `X-Org-Id` header is ignored/rejected. Wiring the Clerk token into
 *    the extension (e.g. via a hosted sign-in tab + chrome.identity) is a
 *    clearly-flagged TODO — see api.ts.
 */

export interface ExtensionSettings {
  /** Base URL of the PeopleOS Fastify API, e.g. http://localhost:3001 (no trailing slash). */
  apiBaseUrl: string;
  /** DEV ONLY — seed org UUID sent as X-Org-Id. Ignored by the API in production. */
  devOrgId: string;
  /** Optional bearer token for prod Clerk-session auth (TODO: auto-provision). */
  authToken: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiBaseUrl: "http://localhost:3001",
  devOrgId: "",
  authToken: "",
};

const STORAGE_KEY = "peopleos.settings";

/** Read settings, falling back to defaults for any missing field. */
export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
}

/** Persist a (partial) settings update. */
export async function saveSettings(update: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const next = { ...(await loadSettings()), ...update };
  // Normalise: strip any trailing slash so path joins stay clean.
  next.apiBaseUrl = next.apiBaseUrl.replace(/\/+$/, "");
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

/** Subscribe to settings changes (e.g. options page edits while a panel is open). */
export function onSettingsChanged(cb: (settings: ExtensionSettings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "sync" || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue as Partial<ExtensionSettings> | undefined;
    cb({ ...DEFAULT_SETTINGS, ...(next ?? {}) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
