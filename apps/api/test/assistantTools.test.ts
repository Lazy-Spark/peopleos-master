import { describe, expect, it } from "vitest";
import { AssistantTool, type UserRole } from "@peopleos/schemas";
import { TOOL_ROLES, WRITE_TOOLS } from "../src/lib/assistantTools.js";

/**
 * Module 10 — guards on the AUTHORITATIVE confused-deputy gate (TOOL_ROLES).
 *
 * TOOL_ROLES (lib/assistantTools.ts) is the SOLE source of truth for "may this role run
 * this tool". The AI-side `tools_for_role` filter is explicitly NOT the security boundary
 * (see services/ai/app/assistant/tools.py header). A WRONG role group here is NOT a TS
 * type error — the `Record<AssistantTool, …>` type only enforces the KEY set, not the
 * value — so without this test a silent widening (e.g. exposing org-wide attrition to an
 * EMPLOYEE) would ship green. These assertions pin every role group to the frozen
 * vocabulary in packages/schemas/src/assistant.ts.
 *
 * Pure (no DB / network). NOTE: the lib's import chain touches @prisma/client, so this
 * suite requires the workspace prepared once — `pnpm install && pnpm db:generate` — before
 * `pnpm --filter @peopleos/api test`.
 */

const ALL: UserRole[] = ["ADMIN", "RECRUITER", "HRBP", "MANAGER", "EMPLOYEE"];
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

// The frozen role groups (mirror the assistant.ts gate comments exactly).
const SELF_SERVICE = [
  "answer_policy_question",
  "raise_hr_ticket",
  "get_my_skill_profile",
  "get_skill_gap",
  "recommended_roles",
  "list_my_tasks",
] as const;
const RECRUITING = [
  "rank_candidates",
  "draft_jd",
  "generate_outreach",
  "find_internal_candidates",
] as const;
const MANAGER_PEOPLE = ["get_employee_attrition", "get_team_skill_map"] as const;
const PEOPLE_ADMIN = [
  "get_analytics_dashboard",
  "ask_workforce_data",
  "get_attrition_summary",
  "get_succession",
  "get_skill_inventory",
  "draft_workflow",
  "start_workflow",
] as const;

describe("TOOL_ROLES — the authoritative per-tool role gate", () => {
  it("covers exactly the frozen AssistantTool vocabulary (no missing/extra tool)", () => {
    expect(new Set(Object.keys(TOOL_ROLES))).toEqual(new Set(AssistantTool.options));
  });

  it("self-service tools are open to ALL roles", () => {
    for (const t of SELF_SERVICE) {
      expect(sorted(TOOL_ROLES[t])).toEqual(sorted(ALL));
    }
  });

  it("recruiting tools are ADMIN/HRBP/RECRUITER only (never MANAGER/EMPLOYEE)", () => {
    for (const t of RECRUITING) {
      expect(sorted(TOOL_ROLES[t])).toEqual(sorted(["ADMIN", "HRBP", "RECRUITER"]));
      expect(TOOL_ROLES[t]).not.toContain("MANAGER");
      expect(TOOL_ROLES[t]).not.toContain("EMPLOYEE");
    }
  });

  it("manager/people tools are ADMIN/HRBP/MANAGER only (never RECRUITER/EMPLOYEE)", () => {
    for (const t of MANAGER_PEOPLE) {
      expect(sorted(TOOL_ROLES[t])).toEqual(sorted(["ADMIN", "HRBP", "MANAGER"]));
      expect(TOOL_ROLES[t]).not.toContain("EMPLOYEE");
      expect(TOOL_ROLES[t]).not.toContain("RECRUITER");
    }
  });

  it("org-wide analytics/governance tools are HRBP/ADMIN only", () => {
    for (const t of PEOPLE_ADMIN) {
      expect(sorted(TOOL_ROLES[t])).toEqual(sorted(["ADMIN", "HRBP"]));
      // Headline guarantee: no one below People-Ops can run org-wide tools.
      expect(TOOL_ROLES[t]).not.toContain("EMPLOYEE");
      expect(TOOL_ROLES[t]).not.toContain("RECRUITER");
      expect(TOOL_ROLES[t]).not.toContain("MANAGER");
    }
  });

  it("get_attrition_summary is never visible below HRBP (canonical over-disclosure guard)", () => {
    expect(TOOL_ROLES["get_attrition_summary"]).not.toContain("EMPLOYEE");
    expect(TOOL_ROLES["get_attrition_summary"]).not.toContain("RECRUITER");
    expect(TOOL_ROLES["get_attrition_summary"]).not.toContain("MANAGER");
  });
});

describe("WRITE_TOOLS — audited action tools", () => {
  it("are exactly the three audited writes", () => {
    expect(new Set(WRITE_TOOLS)).toEqual(
      new Set(["raise_hr_ticket", "generate_outreach", "start_workflow"]),
    );
  });

  it("every write tool is a known tool in the gate", () => {
    for (const t of WRITE_TOOLS) expect(TOOL_ROLES[t]).toBeDefined();
  });
});
