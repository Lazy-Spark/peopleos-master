import {
  LinkedInScrapedProfile,
  type LinkedInEducation as LinkedInEducationT,
  type LinkedInExperience as LinkedInExperienceT,
  type LinkedInScrapedProfile as LinkedInScrapedProfileT,
} from "@peopleos/schemas";

/**
 * DOM scraping for LinkedIn profile pages.
 *
 * IMPORTANT: this module performs NO scraping on import. `scrapeProfile()` is only
 * invoked from the content script AFTER the user clicks the explicit consent button.
 *
 * LinkedIn's markup is unstable and obfuscated, so we read VISIBLE text via resilient,
 * label-anchored selectors and tolerate missing sections (every field is nullable in
 * the frozen LinkedInScrapedProfile contract). We read only what is already rendered on
 * screen — we do not expand collapsed sections, paginate, or fetch additional pages.
 */

/** Collapse whitespace and trim; returns null for empty. */
function clean(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalised = text.replace(/\s+/g, " ").trim();
  return normalised.length > 0 ? normalised : null;
}

/** Read trimmed text from the first matching element, or null. */
function textOf(root: ParentNode, selector: string): string | null {
  const el = root.querySelector(selector);
  return clean(el?.textContent ?? null);
}

/**
 * LinkedIn frequently duplicates text for screen-readers inside
 * `<span aria-hidden="true">…</span><span class="visually-hidden">…</span>`.
 * Prefer the aria-hidden (visible) span to avoid doubled strings.
 */
function visibleText(el: Element | null | undefined): string | null {
  if (!el) return null;
  const visible = el.querySelector('span[aria-hidden="true"]');
  return clean((visible ?? el).textContent ?? null);
}

function scrapeName(): string | null {
  // The H1 in the top card is the most stable anchor for the name.
  return (
    textOf(document, "main h1") ??
    textOf(document, "h1.text-heading-xlarge") ??
    textOf(document, "h1")
  );
}

function scrapeHeadline(): string | null {
  return (
    textOf(document, "div.text-body-medium.break-words") ??
    textOf(document, ".pv-text-details__left-panel .text-body-medium")
  );
}

function scrapeLocation(): string | null {
  return (
    textOf(document, "span.text-body-small.inline.t-black--light.break-words") ??
    textOf(document, ".pv-text-details__left-panel .text-body-small")
  );
}

/**
 * Find a profile <section> by its accessible heading text (e.g. "About",
 * "Experience", "Education", "Skills"). LinkedIn anchors sections with an
 * `id` on a div, then renders the heading in a sibling — we match on the
 * visible heading text to stay resilient to id churn.
 */
function findSection(headings: string[]): Element | null {
  const wanted = headings.map((h) => h.toLowerCase());
  const sections = Array.from(document.querySelectorAll("main section"));
  for (const section of sections) {
    const heading = clean(section.querySelector("h2, h3")?.textContent ?? null);
    if (heading && wanted.some((w) => heading.toLowerCase().startsWith(w))) {
      return section;
    }
  }
  // Fallback: anchor divs LinkedIn uses for deep-links (#about, #experience…).
  for (const h of headings) {
    const anchor = document.getElementById(h.toLowerCase());
    const section = anchor?.closest("section") ?? null;
    if (section) return section;
  }
  return null;
}

function scrapeAbout(): string | null {
  const section = findSection(["About"]);
  if (!section) return null;
  // The about text is the largest visible text block in the section.
  const spans = Array.from(section.querySelectorAll('span[aria-hidden="true"]'));
  const longest = spans
    .map((s) => clean(s.textContent))
    .filter((t): t is string => t !== null)
    .sort((a, b) => b.length - a.length)[0];
  return longest ?? null;
}

function scrapeExperience(): LinkedInExperienceT[] {
  const section = findSection(["Experience"]);
  if (!section) return [];
  const items = Array.from(section.querySelectorAll("li"));
  const out: LinkedInExperienceT[] = [];
  for (const li of items) {
    const title = visibleText(li.querySelector(".t-bold, .mr1.t-bold"));
    const company = visibleText(li.querySelector(".t-14.t-normal:not(.t-black--light)"));
    const dateRange = visibleText(li.querySelector(".t-14.t-normal.t-black--light .pvs-entity__caption-wrapper")) ??
      visibleText(li.querySelector(".pvs-entity__caption-wrapper"));
    const description = visibleText(li.querySelector(".pvs-list__outer-container .t-14.t-normal.t-black"));
    if (title || company) {
      out.push({ title, company, dateRange, description });
    }
  }
  return out;
}

function scrapeEducation(): LinkedInEducationT[] {
  const section = findSection(["Education"]);
  if (!section) return [];
  const items = Array.from(section.querySelectorAll("li"));
  const out: LinkedInEducationT[] = [];
  for (const li of items) {
    const school = visibleText(li.querySelector(".t-bold, .mr1.t-bold"));
    const degreeField = visibleText(li.querySelector(".t-14.t-normal:not(.t-black--light)"));
    if (!school && !degreeField) continue;
    // LinkedIn packs "Degree, Field of study" into one line; split heuristically.
    let degree: string | null = null;
    let field: string | null = null;
    if (degreeField) {
      const parts = degreeField.split(/[,·]/).map((p) => p.trim()).filter(Boolean);
      degree = parts[0] ?? null;
      field = parts.length > 1 ? parts.slice(1).join(", ") : null;
    }
    out.push({ school, degree, field });
  }
  return out;
}

function scrapeSkills(): string[] {
  const section = findSection(["Skills"]);
  if (!section) return [];
  const items = Array.from(section.querySelectorAll("li .t-bold span[aria-hidden=\"true\"], li .mr1.t-bold span[aria-hidden=\"true\"]"));
  const skills = items
    .map((el) => clean(el.textContent))
    .filter((t): t is string => t !== null);
  // De-duplicate while preserving order.
  return Array.from(new Set(skills));
}

/**
 * Build a LinkedInScrapedProfile from the currently rendered profile page and
 * validate it against the frozen contract. Throws if the URL is unusable.
 *
 * Called ONLY after explicit user consent (see content/index.ts).
 */
export function scrapeProfile(): LinkedInScrapedProfileT {
  // Canonicalise to the public profile URL (drop tracking query params).
  const url = `${window.location.origin}${window.location.pathname}`;

  const candidate = {
    url,
    name: scrapeName(),
    headline: scrapeHeadline(),
    location: scrapeLocation(),
    about: scrapeAbout(),
    experience: scrapeExperience(),
    education: scrapeEducation(),
    skills: scrapeSkills(),
  };

  // Validate before handing off — guarantees the background worker + API receive a
  // contract-shaped payload (defaults fill empty arrays; url must be a valid URL).
  return LinkedInScrapedProfile.parse(candidate);
}
