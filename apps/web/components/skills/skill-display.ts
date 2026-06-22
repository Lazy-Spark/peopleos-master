import type {
  ProficiencyLevel,
  SkillCategory,
  SkillSource,
} from "@peopleos/schemas";

/**
 * Shared, display-only label/style maps for the Module 6 skill-graph UI. Keyed
 * off the FROZEN `@peopleos/schemas` enums so the union is exhaustive at compile
 * time (a new enum member is a type error here). No business logic — confidence
 * is always source-derived server-side via `confidenceForSource`; these maps only
 * format the values the API returns.
 */

/** Proficiency rank for sorting / heatmap intensity (AWARE lowest → EXPERT highest). */
export const PROFICIENCY_RANK: Record<ProficiencyLevel, number> = {
  AWARE: 1,
  PRACTITIONER: 2,
  ADVANCED: 3,
  EXPERT: 4,
};

export const PROFICIENCY_LABEL: Record<ProficiencyLevel, string> = {
  AWARE: "Aware",
  PRACTITIONER: "Practitioner",
  ADVANCED: "Advanced",
  EXPERT: "Expert",
};

/** Ordered list for selects (lowest → highest), kept in sync with the enum. */
export const PROFICIENCY_ORDER: ReadonlyArray<ProficiencyLevel> = [
  "AWARE",
  "PRACTITIONER",
  "ADVANCED",
  "EXPERT",
];

export const CATEGORY_LABEL: Record<SkillCategory, string> = {
  TECHNICAL: "Technical",
  DOMAIN: "Domain",
  SOFT: "Soft skills",
  LANGUAGE: "Languages",
  CERTIFICATION: "Certifications",
};

/** Stable category display order (technical-first, certifications last). */
export const CATEGORY_ORDER: ReadonlyArray<SkillCategory> = [
  "TECHNICAL",
  "DOMAIN",
  "SOFT",
  "LANGUAGE",
  "CERTIFICATION",
];

/**
 * How a skill assertion's confidence was established (spec Layer 3A scoring).
 * Labels mirror the source enum; the numeric confidence is derived server-side.
 */
export const SOURCE_LABEL: Record<SkillSource, string> = {
  SELF_REPORTED: "Self-reported",
  MANAGER_VERIFIED: "Manager-verified",
  ASSESSMENT_VERIFIED: "Assessment-verified",
  INFERRED_RESUME: "Inferred (resume)",
  INFERRED_PROJECT: "Inferred (project)",
};

/** Verified provenance gets a trust accent; inferred/self stays neutral. */
export function isVerifiedSource(source: SkillSource): boolean {
  return source === "MANAGER_VERIFIED" || source === "ASSESSMENT_VERIFIED";
}

/** A unit confidence score [0,1] → "80%". */
export function confidencePct(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}
