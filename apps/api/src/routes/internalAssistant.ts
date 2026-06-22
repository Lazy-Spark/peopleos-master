import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError, AssistantTool, ToolInvokeRequest, ToolInvokeResponse } from "@peopleos/schemas";
import { requireInternalSecret } from "../lib/internalSecret.js";
import { dispatchAssistantTool, TOOL_ROLES } from "../lib/assistantTools.js";

/**
 * Module 10 — Agentic HR Assistant: the INTERNAL tool dispatcher.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TRUST BOUNDARY — read before changing anything in this file.
 *
 * Mounted at the ROOT (outside /api/v1), with NO Clerk/tenancy preHandler. It is the
 * callback the AI service's ReAct loop hits to run a tool. Authentication is the SAME
 * constant-time `x-internal-secret` shared-secret guard as /internal/copilot/*
 * (lib/internalSecret.ts; fail-closed when AI_SERVICE_SECRET is unset).
 *
 * THE CONFUSED-DEPUTY DEFENCE (the whole point of this module):
 *   - The agent (an LLM) PROPOSES a tool + args; it is NEVER trusted to authorise itself.
 *   - IDENTITY (orgId / userId / role) comes EXCLUSIVELY from `body.context` — the
 *     trusted AssistantContext the API set from the authenticated session and relayed to
 *     the AI, which re-attached it PROGRAMMATICALLY. We IGNORE any orgId/userId/role a
 *     (prompt-injected) agent might smuggle into `body.args`.
 *   - A server-side ALLOWLIST (TOOL_ROLES) re-derives the permitted roles for the
 *     requested tool from context.role. If the role is not permitted, we return
 *     ok:false / "forbidden" WITHOUT running anything — the agent's tool choice is
 *     advisory, not authoritative.
 *   - The permitted tool then runs inside withTenant(context.orgId) and re-applies that
 *     module's OWN governance from context.role (manager sees attrition TIER for an own
 *     report only, flightRisk is ADMIN/HRBP-only, employee sees only their own data …).
 *     See lib/assistantTools.ts.
 *
 * Bind on the internal network / service mesh only; never expose /internal/* publicly.
 * ────────────────────────────────────────────────────────────────────────────
 */

const internalAssistantRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /internal/assistant/tool — run one Module 10 tool with re-enforced governance.
  r.post(
    "/internal/assistant/tool",
    {
      preHandler: requireInternalSecret,
      schema: {
        tags: ["internal"],
        summary: "ReAct tool dispatcher: run one Module 10 assistant tool (role-governed).",
        description:
          "The AI service's agent loop calls this to run a tool. Identity (orgId/userId/role) is read ONLY from body.context (the trusted session relay); identity fields in body.args are ignored. A server-side allowlist re-checks the role; a disallowed tool returns ok:false/'forbidden'. The permitted tool runs under withTenant + that module's own governance.",
        body: ToolInvokeRequest,
        response: { 200: ToolInvokeResponse, 400: ApiError, 401: ApiError },
      },
    },
    async (request) => {
      const { tool, args, context } = request.body;

      // The tool name must be in the canonical vocabulary (the agent cannot invent one).
      const parsedTool = AssistantTool.safeParse(tool);
      if (!parsedTool.success) {
        return ToolInvokeResponse.parse({
          ok: false,
          data: null,
          summary: "not permitted",
          error: "unknown_tool",
        });
      }
      const toolName = parsedTool.data;

      // THE GATE: re-derive the per-tool role allowlist from the TRUSTED context.role.
      // The agent's choice is NOT trusted — a disallowed tool runs nothing.
      const permittedRoles = TOOL_ROLES[toolName];
      if (!permittedRoles.includes(context.role)) {
        return ToolInvokeResponse.parse({
          ok: false,
          data: null,
          summary: "not permitted",
          error: "forbidden",
        });
      }

      // Route the permitted tool to its module lib. All identity comes from `context`;
      // `args` (a record) carry only tool-specific params. Errors are caught inside the
      // dispatcher and surfaced as ok:false so the agent loop never crashes.
      return dispatchAssistantTool(toolName, args, context, request.ip);
    },
  );
};

export default internalAssistantRoutes;
