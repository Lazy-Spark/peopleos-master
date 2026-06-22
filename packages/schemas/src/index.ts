/**
 * @peopleos/schemas — canonical Zod contracts for PeopleOS.
 *
 * Single source of truth shared by the Fastify API, the Next.js web app, and
 * (mirrored as Pydantic) the Python AI service. Import from here, never redefine
 * these shapes locally.
 */
export * from "./common.js";
export * from "./candidate.js";
export * from "./job.js";
export * from "./application.js";
export * from "./ranking.js";
export * from "./ai.js";
export * from "./audit.js";
export * from "./copilot.js";
export * from "./interview.js";
export * from "./knowledge.js";
export * from "./analytics.js";
export * from "./skills.js";
export * from "./attrition.js";
export * from "./mobility.js";
export * from "./workflow.js";
export * from "./assistant.js";
