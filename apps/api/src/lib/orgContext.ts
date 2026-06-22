import { z } from "zod";
import { OrgContext, type OrgContext as TOrgContext } from "@peopleos/schemas";

/**
 * Build the per-org prompt context (prompt-engineering standard #1) from the
 * Organisation row + the reviewing user's role. Absent fields → generic prompt
 * framing in the AI service.
 *
 * The Organisation.settings JSON column is free-form; we read only the
 * prompt-relevant slice (industry / headcount / tone / custom rules) and ignore
 * the rest (e.g. ranking weights live there too). Shared by Module 1 ranking and
 * Module 2 copilot so the org context shape stays identical across every LLM call.
 */
const OrgPromptSettings = z
  .object({
    industry: z.string().nullable().optional(),
    headcount: z.number().int().nullable().optional(),
    tonePreferences: z.string().nullable().optional(),
    customRules: z.array(z.string()).optional(),
  })
  .passthrough();

export function buildOrgContext(
  org: { name: string | null; settings: unknown } | null,
  userRole: TOrgContext["userRole"],
): TOrgContext {
  const parsed = OrgPromptSettings.safeParse(org?.settings ?? {});
  const s = parsed.success ? parsed.data : {};
  return OrgContext.parse({
    orgName: org?.name ?? null,
    userRole: userRole ?? null,
    industry: s.industry ?? null,
    headcount: s.headcount ?? null,
    tonePreferences: s.tonePreferences ?? null,
    customRules: s.customRules ?? [],
  });
}
