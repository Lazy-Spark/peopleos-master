import { useEffect, useState } from "react";
import { z } from "zod";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ExtensionSettings } from "../lib/settings.js";

/**
 * Options page: configure the PeopleOS API base URL, a dev org id (X-Org-Id), and an
 * optional Clerk session token for production auth.
 *
 * Validation reuses the same primitive constraints as the backend: orgId is a UUID,
 * apiBaseUrl is a URL.
 */

const Uuid = z.string().uuid();
const Url = z.string().url();

type SaveState = "idle" | "saving" | "saved" | "invalid";

export default function Options(): JSX.Element {
  const [draft, setDraft] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [state, setState] = useState<SaveState>("idle");
  const [errors, setErrors] = useState<{ apiBaseUrl?: string; devOrgId?: string }>({});

  useEffect(() => {
    void loadSettings().then(setDraft);
  }, []);

  function validate(next: ExtensionSettings): boolean {
    const e: { apiBaseUrl?: string; devOrgId?: string } = {};
    if (!Url.safeParse(next.apiBaseUrl).success) {
      e.apiBaseUrl = "Enter a valid URL, e.g. http://localhost:3001";
    }
    // devOrgId is optional (prod uses a token), but if present it must be a UUID.
    if (next.devOrgId && !Uuid.safeParse(next.devOrgId).success) {
      e.devOrgId = "Org id must be a UUID (your seed org id).";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSave(evt: React.FormEvent): Promise<void> {
    evt.preventDefault();
    if (!validate(draft)) {
      setState("invalid");
      return;
    }
    setState("saving");
    const saved = await saveSettings(draft);
    setDraft(saved);
    setState("saved");
    window.setTimeout(() => setState("idle"), 2000);
  }

  function update<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  return (
    <div
      style={{
        maxWidth: 560,
        margin: "32px auto",
        padding: "0 20px",
        font: "14px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif",
        color: "#1d2226",
      }}
    >
      <h1 style={{ fontSize: 20 }}>PeopleOS Recruiter Copilot — Settings</h1>
      <p style={{ color: "#5e6b74" }}>
        Connect the extension to your PeopleOS API. In development the API trusts an{" "}
        <code>X-Org-Id</code> header; in production it uses your Clerk session.
      </p>

      <form onSubmit={(e) => void onSave(e)} style={{ display: "grid", gap: 18 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>API base URL</span>
          <input
            type="url"
            value={draft.apiBaseUrl}
            placeholder="http://localhost:3001"
            onChange={(e) => update("apiBaseUrl", e.target.value)}
            style={inputStyle}
          />
          {errors.apiBaseUrl && <small style={errStyle}>{errors.apiBaseUrl}</small>}
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>Dev org id (X-Org-Id)</span>
          <input
            type="text"
            value={draft.devOrgId}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => update("devOrgId", e.target.value.trim())}
            style={inputStyle}
          />
          <small style={{ color: "#5e6b74" }}>
            Dev only. Paste a seed org UUID. The API ignores this in production.
          </small>
          {errors.devOrgId && <small style={errStyle}>{errors.devOrgId}</small>}
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>
            Clerk session token (production) <span style={{ color: "#5e6b74" }}>— optional</span>
          </span>
          <textarea
            value={draft.authToken}
            placeholder="Bearer token — TODO: auto-provisioned in a future release"
            onChange={(e) => update("authToken", e.target.value.trim())}
            rows={3}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
          />
          <small style={{ color: "#5e6b74" }}>
            When set, sent as <code>Authorization: Bearer …</code>. Automatic Clerk
            sign-in inside the extension is a planned enhancement.
          </small>
        </label>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="submit"
            disabled={state === "saving"}
            style={{
              background: "#0a66c2",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "10px 18px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {state === "saving" ? "Saving…" : "Save"}
          </button>
          {state === "saved" && <span style={{ color: "#1a7f37" }}>Saved.</span>}
          {state === "invalid" && <span style={errStyle}>Fix the errors above.</span>}
        </div>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: "1px solid #e3e6e8",
  borderRadius: 8,
  padding: "9px 11px",
  font: "inherit",
};

const errStyle: React.CSSProperties = { color: "#b42318" };
