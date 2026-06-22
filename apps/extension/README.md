# @peopleos/extension — Recruiter Copilot LinkedIn Sidebar (Module 2d)

A Manifest V3 Chrome/Edge browser extension for PeopleOS **Module 2 (Recruiter Copilot)**,
sub-feature **2d**. On a LinkedIn profile it scrapes the visible profile fields **only after
explicit recruiter consent**, sends them to the PeopleOS API, and renders an AI summary plus a
role-match list (title, match score, tier, top gaps) with an **Add to Pool** action.

Built with **Vite + `@crxjs/vite-plugin`** (MV3) and **React** for the side panel and options
page. It shares the FROZEN Zod contracts from `@peopleos/schemas` (`workspace:*`) so wire shapes
are validated end-to-end and never redeclared here.

---

## What it does

- **Content script** (`src/content/`) — injected on `linkedin.com/in/*` and `linkedin.com/jobs/*`.
  Detects the page kind and injects a floating **"Analyze with PeopleOS (consent)"** button.
  Nothing is scraped or transmitted until that button (or an equivalent panel button, which is
  itself a user click) is pressed. `scrape.ts` reads the visible profile into a
  `LinkedInScrapedProfile` and validates it against the frozen schema before handoff.
- **Background service worker** (`src/background/`) — receives the consented profile, calls
  `POST {API_BASE}/api/v1/copilot/linkedin/analyze` with `{ profile, consent: true }`, and pushes
  the validated `AnalyzeLinkedInResponse` to the side panel. Handles **Add to Pool**
  (`POST /api/v1/copilot/linkedin/add-to-pool` with `{ profile, consent: true, source }`). Also
  opens the side panel on toolbar-icon click.
- **Side panel** (`src/sidepanel/`) — React UI: AI summary, role-match cards (tier badge, match %,
  skill %, top gaps), bias-check note, and the **Add to Pool** button.
- **Options page** (`src/options/`) — set the API base URL, a dev org id, and (optionally) a Clerk
  session token. Persisted in `chrome.storage.sync`.
- **API client** (`src/api.ts`) — typed `fetch` wrapper that validates every response with
  `@peopleos/schemas`. Mirrors `apps/web/lib/api.ts`.

> **The frozen `AnalyzeLinkedInRequest` also has `orgId` and `roles[]`.** The extension cannot know
> the tenant (server-trusted) or query the org's open roles (DB-only), so it sends just
> `{ profile, consent: true }`; the **API** fills `orgId` (from the authenticated session) and
> `roles` (from the DB) before calling the AI service.

### Prompt-engineering / privacy alignment
- **Consent gate** — no scrape or network call happens without the explicit consent click
  (spec 2d: "with consent"; `consent` is `z.literal(true)` in the frozen contract).
- **Minimal scope** — `host_permissions` is `https://www.linkedin.com/*` only; no `<all_urls>`,
  `tabs`, `cookies`, or `webRequest`. The content script only reads already-visible text.
- **Bias check** — the panel surfaces `biasCheck.biasIndicatorsDetected` / `correctionApplied`
  from the AI response so the recruiter sees what was flagged.

---

## Permissions (and why)

| Permission | Reason |
| --- | --- |
| `activeTab` | Read the active LinkedIn tab only after a user gesture. |
| `storage` | Persist API base URL / dev org id / token from the options page. |
| `sidePanel` | The recruiter-facing UI surface. |
| `scripting` | Background messages the content script to perform the consented scrape. |
| `host_permissions: https://www.linkedin.com/*` | The only site the extension ever touches. |

---

## Build & load (Chrome / Edge)

Prereqs: the monorepo deps are installed (`pnpm install` at the repo root) so `@peopleos/schemas`
resolves as a workspace package.

```bash
# from the repo root
pnpm install                            # once, if not already done
pnpm --filter @peopleos/extension build # emits apps/extension/dist/
# dev (HMR for the panel/options; content script reloads on save):
pnpm --filter @peopleos/extension dev
```

Then load it unpacked:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select **`apps/extension/dist`** (after `build`) — for `dev`,
   `@crxjs/vite-plugin` writes a live `dist/` that updates on save; point "Load unpacked" there.
4. Pin the **PeopleOS Recruiter Copilot** icon. Click it to open the side panel.

### First-run setup
1. Click the extension icon → **Settings** (or right-click → Options).
2. Set **API base URL** (e.g. `http://localhost:3001`).
3. Set **Dev org id** to a seed org UUID (see `prisma/seed.ts`).
4. Save.

### Try it
1. Open any `https://www.linkedin.com/in/<someone>` profile.
2. Click the floating **"Analyze with PeopleOS (consent)"** button (or the panel button).
3. The side panel shows the AI summary, role matches, and **Add to Pool**.

---

## Auth caveat (dev vs prod)

This mirrors the API auth model (`apps/api/src/plugins/auth.ts`):

- **Development** — when the API has no Clerk secret configured (`NODE_ENV !== "production"`), it
  trusts an **`X-Org-Id`** header to resolve the tenant for RLS. The extension sends the **Dev org
  id** from options as that header. This is a dev-only convenience and is the only client-supplied
  tenant path the API allows.
- **Production** — the org is derived **server-side** from a verified **Clerk session**. The
  extension must then send `Authorization: Bearer <clerk session jwt>` and `X-Org-Id` is ignored.

> **TODO (prod auth):** obtaining the Clerk session JWT inside the extension is **not yet wired**.
> The Options page has a token field that, when set, is sent as `Authorization: Bearer …`, but
> automatic sign-in (e.g. a hosted PeopleOS sign-in tab + `chrome.identity.launchWebAuthFlow` or a
> `postMessage` bridge, with 401 refresh) is a planned enhancement. Until then the extension is
> **dev-only**. See `src/api.ts` (`TODO(prod-auth)`).

---

## Needs manual browser testing (cannot be verified in CI)

This is a coherent, type-checked skeleton; the following require a real browser + a running API:

- **LinkedIn DOM selectors** in `src/content/scrape.ts` are best-effort against LinkedIn's
  obfuscated, frequently-changing markup. Field extraction (about / experience / education /
  skills) must be verified on live profiles and will likely need tuning. Every field is nullable
  in the contract, so partial extraction degrades gracefully.
- **Side-panel open-on-gesture** — `chrome.sidePanel.open()` must run inside a user gesture;
  verify the toolbar click and the in-page consent button both open the panel.
- **End-to-end API round-trip** — requires the API to expose
  `POST /api/v1/copilot/linkedin/analyze` and `/add-to-pool` (built in the API subtree) and a
  running AI service.
- **MV3 service-worker lifecycle** — confirm the worker wakes correctly to handle messages after
  idle suspension.

---

## File map

```
apps/extension/
├─ manifest.config.ts        # MV3 manifest (typed; consumed by @crxjs/vite-plugin)
├─ vite.config.ts            # Vite + crxjs + react; @peopleos/schemas alias
├─ eslint.config.js          # flat config; no-explicit-any enforced
├─ public/icons/             # toolbar/action icons (16/32/48/128)
└─ src/
   ├─ api.ts                 # typed API client (validates responses with @peopleos/schemas)
   ├─ vite-env.d.ts
   ├─ lib/
   │  ├─ settings.ts         # chrome.storage.sync settings + change subscription
   │  └─ messages.ts         # typed message bus (content ⇄ background ⇄ panel)
   ├─ content/
   │  ├─ index.ts            # page detection + consent button + messaging
   │  └─ scrape.ts           # consented LinkedIn DOM → LinkedInScrapedProfile
   ├─ background/
   │  └─ index.ts            # service worker: analyze + add-to-pool + panel open
   ├─ sidepanel/
   │  ├─ index.html · main.tsx · App.tsx · styles.css
   └─ options/
      ├─ index.html · main.tsx · Options.tsx
```
