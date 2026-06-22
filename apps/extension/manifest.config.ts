import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

/**
 * PeopleOS Recruiter Copilot — Manifest V3 (Chrome/Edge).
 *
 * Module 2d "LinkedIn Sidebar Extension". Scopes:
 *  - host_permissions: ONLY https://www.linkedin.com/* — we never read any other site.
 *  - content_scripts: injected on profile (/in/*) and job (/jobs/*) pages. The script
 *    only OBSERVES the page (detect type, surface the consent action). It does NOT
 *    scrape or transmit anything until the user clicks "Analyze with PeopleOS (consent)".
 *  - side_panel: the recruiter-facing UI (AI summary, role matches, Add to Pool).
 *  - permissions:
 *      activeTab  — read the active LinkedIn tab only after user gesture.
 *      storage    — persist the dev API base URL + dev org id from the options page.
 *      sidePanel  — open the side panel from the toolbar action.
 *      scripting  — (background) message the content script to perform a scrape.
 *
 * Deliberately NOT requested: <all_urls>, tabs, cookies, webRequest, history.
 */
export default defineManifest({
  manifest_version: 3,
  name: "PeopleOS Recruiter Copilot",
  version: pkg.version,
  description:
    "PeopleOS Recruiter Copilot — analyse LinkedIn profiles against your open roles (with consent) and add to your candidate pool.",
  minimum_chrome_version: "114",

  action: {
    default_title: "PeopleOS Recruiter Copilot",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },

  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },

  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },

  side_panel: {
    default_path: "src/sidepanel/index.html",
  },

  options_page: "src/options/index.html",

  permissions: ["activeTab", "storage", "sidePanel", "scripting"],

  host_permissions: ["https://www.linkedin.com/*"],

  content_scripts: [
    {
      matches: ["https://www.linkedin.com/in/*", "https://www.linkedin.com/jobs/*"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
});
