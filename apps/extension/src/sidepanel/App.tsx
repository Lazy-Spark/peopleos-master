import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AddToPoolResponse,
  AnalyzeLinkedInResponse,
  LinkedInRoleMatch,
  LinkedInScrapedProfile,
} from "@peopleos/schemas";
import { isRuntimeMessage, type PageContext, type RuntimeMessage } from "../lib/messages.js";
import { loadSettings, onSettingsChanged, type ExtensionSettings } from "../lib/settings.js";

/**
 * Side-panel UI for the Recruiter Copilot LinkedIn extension.
 *
 * Flow:
 *   1. User clicks the in-page "Analyze with PeopleOS (consent)" button (content script),
 *      OR the "Analyze this profile" button here (which forwards a scrape request to the
 *      active tab — itself a user gesture, preserving consent).
 *   2. Background calls POST /copilot/linkedin/analyze and pushes ANALYSIS_RESULT.
 *   3. The panel renders the AI summary + role-match list, and offers "Add to Pool"
 *      (POST /copilot/linkedin/add-to-pool).
 */

type Status =
  | { kind: "idle" }
  | { kind: "analyzing"; profile: LinkedInScrapedProfile }
  | { kind: "done"; result: AnalyzeLinkedInResponse; profile: LinkedInScrapedProfile }
  | { kind: "error"; scope: string; message: string };

type PoolStatus =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "added"; result: AddToPoolResponse }
  | { kind: "error"; message: string };

function send(message: RuntimeMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Worker may be spinning up; commands are idempotent enough to drop on failure.
  });
}

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function TierBadge({ tier }: { tier: LinkedInRoleMatch["tier"] }): JSX.Element {
  return <span className={`po-tier po-tier--${tier}`}>Tier {tier}</span>;
}

function RoleMatchCard({ match }: { match: LinkedInRoleMatch }): JSX.Element {
  const pct = Math.round(match.matchScore * 100);
  return (
    <li className="po-match">
      <div className="po-match__head">
        <span className="po-match__title">{match.title}</span>
        <TierBadge tier={match.tier} />
      </div>
      <div className="po-meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="po-meter__fill" style={{ width: `${String(pct)}%` }} />
      </div>
      <div className="po-muted" style={{ fontSize: 11 }}>
        Match {pct}% · Skills {Math.round(match.skillMatchPct)}%
      </div>
      {match.topGaps.length > 0 && (
        <div>
          <div className="po-section-title" style={{ margin: "4px 0 2px" }}>
            Top gaps
          </div>
          <ul className="po-gaps">
            {match.topGaps.map((gap, i) => (
              <li key={`${gap}-${String(i)}`}>{gap}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [context, setContext] = useState<PageContext | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pool, setPool] = useState<PoolStatus>({ kind: "idle" });

  // Load settings + subscribe to changes.
  useEffect(() => {
    void loadSettings().then(setSettings);
    return onSettingsChanged(setSettings);
  }, []);

  // Ask the active tab for its page context on mount.
  useEffect(() => {
    void (async () => {
      const tabId = await getActiveTabId();
      if (tabId === null) return;
      try {
        const ctx = (await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_CONTEXT" })) as
          | PageContext
          | undefined;
        if (ctx) setContext(ctx);
      } catch {
        // Content script not present on this tab (not a LinkedIn page).
        setContext(null);
      }
    })();
  }, []);

  // Receive pushes from the background worker.
  useEffect(() => {
    const listener = (raw: unknown): void => {
      if (!isRuntimeMessage(raw)) return;
      switch (raw.type) {
        case "PAGE_CONTEXT":
          setContext(raw.context);
          break;
        case "ANALYSIS_STARTED":
          setPool({ kind: "idle" });
          setStatus({ kind: "analyzing", profile: raw.profile });
          break;
        case "ANALYSIS_RESULT":
          setStatus({ kind: "done", result: raw.result, profile: raw.profile });
          break;
        case "ADDED_TO_POOL":
          setPool({ kind: "added", result: raw.result });
          break;
        case "ERROR":
          if (raw.scope === "add-to-pool") {
            setPool({ kind: "error", message: raw.message });
          } else {
            setStatus({ kind: "error", scope: raw.scope, message: raw.message });
          }
          break;
        default:
          break;
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const analyze = useCallback(async () => {
    const tabId = await getActiveTabId();
    if (tabId === null) {
      setStatus({ kind: "error", scope: "scrape", message: "No active tab." });
      return;
    }
    setPool({ kind: "idle" });
    send({ type: "ANALYZE", tabId });
  }, []);

  const addToPool = useCallback(() => {
    if (status.kind !== "done") return;
    setPool({ kind: "adding" });
    send({ type: "ADD_TO_POOL", profile: status.profile });
  }, [status]);

  const configured = useMemo(
    () => Boolean(settings && settings.apiBaseUrl && (settings.devOrgId || settings.authToken)),
    [settings],
  );

  const onProfilePage = context?.kind === "profile";

  return (
    <div className="po-panel">
      <header className="po-header">
        <div>
          <div className="po-header__title">PeopleOS Copilot</div>
          <div className="po-header__sub">
            {context?.label ?? (onProfilePage ? "LinkedIn profile" : "Open a LinkedIn profile")}
          </div>
        </div>
        <button
          className="po-link"
          type="button"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          Settings
        </button>
      </header>

      <main className="po-body">
        {!configured && (
          <div className="po-banner po-banner--info">
            Not configured yet. Open{" "}
            <button className="po-link" type="button" onClick={() => void chrome.runtime.openOptionsPage()}>
              Settings
            </button>{" "}
            and set the API base URL and a dev org id.
          </div>
        )}

        {configured && !onProfilePage && (
          <div className="po-banner po-banner--info">
            Open a LinkedIn profile (linkedin.com/in/…) and click{" "}
            <strong>Analyze with PeopleOS (consent)</strong>, or use the button below.
          </div>
        )}

        {configured && (
          <button
            className="po-btn"
            type="button"
            onClick={() => void analyze()}
            disabled={!onProfilePage || status.kind === "analyzing"}
          >
            {status.kind === "analyzing" ? (
              <>
                <span className="po-spinner" />
                Analyzing…
              </>
            ) : (
              "Analyze this profile (consent)"
            )}
          </button>
        )}

        {status.kind === "error" && (
          <div className="po-banner po-banner--error">
            <strong>Analysis failed.</strong> {status.message}
          </div>
        )}

        {status.kind === "done" && (
          <>
            <section className="po-card">
              <h2 className="po-section-title">AI summary</h2>
              <p style={{ margin: 0 }}>{status.result.summary}</p>
              {status.result.biasCheck.biasIndicatorsDetected.length > 0 && (
                <p className="po-muted" style={{ fontSize: 11, marginBottom: 0 }}>
                  Bias indicators flagged: {status.result.biasCheck.biasIndicatorsDetected.join(", ")}
                  {status.result.biasCheck.correctionApplied ? " (correction applied)" : ""}
                </p>
              )}
            </section>

            <section>
              <h2 className="po-section-title">Role matches</h2>
              {status.result.roleMatches.length === 0 ? (
                <p className="po-muted">No open roles to benchmark against.</p>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                  {status.result.roleMatches.map((match) => (
                    <RoleMatchCard key={match.jobId} match={match} />
                  ))}
                </ul>
              )}
            </section>

            <section>
              {pool.kind === "added" ? (
                <div className="po-banner po-banner--success">
                  Added to pool. Candidate id: <code>{pool.result.candidateId}</code>
                </div>
              ) : (
                <>
                  <button
                    className="po-btn po-btn--ghost"
                    type="button"
                    onClick={addToPool}
                    disabled={pool.kind === "adding"}
                  >
                    {pool.kind === "adding" ? (
                      <>
                        <span className="po-spinner" />
                        Adding…
                      </>
                    ) : (
                      "Add to Pool"
                    )}
                  </button>
                  {pool.kind === "error" && (
                    <div className="po-banner po-banner--error" style={{ marginTop: 8 }}>
                      {pool.message}
                    </div>
                  )}
                </>
              )}
              <p className="po-muted" style={{ fontSize: 11, marginTop: 8 }}>
                Adding stores this candidate with source LINKEDIN and your explicit consent.
              </p>
            </section>
          </>
        )}

        {status.kind === "idle" && configured && onProfilePage && (
          <p className="po-muted">
            We only read what is visible on this profile, and only after you click consent.
          </p>
        )}
      </main>
    </div>
  );
}
