import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AddToPoolRequest,
  AddToPoolResponse,
  AnalyzeLinkedInRequest,
  AnalyzeLinkedInResponse,
  ApiError,
  CandidateProfile,
  GeneratedJobDescription,
  GenerateOutreachRequest,
  JDStructured,
  LinkedInMatchRole,
  LinkedInScrapedProfile,
  OutreachResult,
  RecruiterChatRequest,
  RecruiterChatResponse,
  RoleLevel,
  WriteJobDescriptionRequest,
  type CandidateProfile as TCandidateProfile,
} from "@peopleos/schemas";
import { withTenant } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import { writeAudit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { aiClient } from "../lib/aiClient.js";
import { buildOrgContext } from "../lib/orgContext.js";
import { serializeCandidate } from "../lib/serialize.js";

/**
 * Module 2 — Recruiter Copilot routes (mounted under /api/v1, tenant-scoped).
 *
 *   2a JD Writer     : POST /api/v1/copilot/jd
 *   2b Outreach      : POST /api/v1/applications/:id/outreach
 *   2c Chat assistant: POST /api/v1/copilot/chat
 *   2d LinkedIn      : POST /api/v1/copilot/linkedin/analyze
 *                      POST /api/v1/copilot/linkedin/add-to-pool
 *
 * Every handler runs under requireTenant + withTenant(orgId), so RLS scopes all DB
 * access to the caller's org and the orgId sent to the AI service ALWAYS comes from
 * the authenticated session — never from a client-supplied body field. The internal
 * ReAct tool router (/internal/copilot/*) is a separate, secret-authenticated file.
 */

// ── Request bodies (server supplies orgId / orgContext / few-shot from the DB) ──

/** 2a JD Writer body: the client supplies only the role brief. */
const JdWriterBody = z.object({
  roleTitle: z.string().min(1),
  seniority: RoleLevel.nullable().optional(),
  department: z.string().nullable().optional(),
  teamContext: z.string().nullable().optional(),
  hiringManagerNotes: z.string().nullable().optional(),
});

/** 2c Chat body: messages + optional active-pipeline context. orgId/userRole are
 *  taken from the session, NEVER from the body (defence against tenant spoofing). */
const ChatBody = z.object({
  messages: RecruiterChatRequest.shape.messages,
  jobId: RecruiterChatRequest.shape.jobId,
});

/** 2d LinkedIn analyze body: the scraped profile + consent. The org's open roles
 *  are loaded server-side (the AI service cannot query the DB), so `roles` and
 *  `orgId` are NOT accepted from the client. */
const LinkedInAnalyzeBody = z.object({
  profile: LinkedInScrapedProfile,
  consent: z.boolean(),
});

const ApplicationIdParam = z.object({ id: z.string().uuid() });

/** How many of the org's recent JDs to send as tone-matched few-shot examples. */
const PRIOR_JD_LIMIT = 5;

/**
 * Map a LinkedIn-scraped profile to the canonical CandidateProfile shape so a
 * candidate created via "Add to Pool" is structurally consistent with one produced
 * by the resume pipeline. We do NOT invent data: only fields present on the scrape
 * are carried over; everything else defaults empty/null (the full resume pipeline
 * can enrich it later). `resumeParsedAt` stays null — this was not resume-parsed.
 */
function linkedInToCandidateProfile(
  profile: z.infer<typeof LinkedInScrapedProfile>,
): TCandidateProfile {
  return CandidateProfile.parse({
    name: profile.name,
    email: null,
    phone: null,
    linkedinUrl: profile.url,
    githubUrl: null,
    location: profile.location,
    education: profile.education.map((e) => ({
      school: e.school ?? "",
      degree: e.degree,
      field: e.field,
      startYear: null,
      endYear: null,
    })),
    experience: profile.experience.map((x) => ({
      company: x.company ?? "",
      title: x.title ?? "",
      startDate: null,
      endDate: null,
      description: x.description,
      isCurrent: false,
    })),
    skills: profile.skills.map((name) => ({
      canonicalName: name,
      rawName: name,
      category: "TECHNICAL" as const,
      proficiency: null,
      // Scraped, unverified self-listed skill → low confidence.
      confidence: 0.5,
    })),
    certifications: [],
    languages: [],
    publications: [],
    gaps: [],
    totalYoe: null,
  });
}

const copilotRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── 2a — JD Writer ──────────────────────────────────────────────────────────
  r.post(
    "/copilot/jd",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["copilot"],
        summary: "Generate a job description (Module 2a — JD Writer).",
        description:
          "Loads the org context + a few of the org's recent JD texts as tone-matched few-shot examples, then asks the AI service to draft a full inclusive JD (with an inclusive-language report + biasCheck). Tenant-scoped.",
        body: JdWriterBody,
        response: { 200: GeneratedJobDescription, 400: ApiError, 401: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      const body = request.body;

      // Load org (→ orgContext) + the org's recent JD texts (→ tone few-shot).
      const { org, priorJdExamples } = await withTenant(orgId, async (tx) => {
        const [orgRow, jobs] = await Promise.all([
          tx.organisation.findUnique({ where: { id: orgId } }),
          tx.jobOpening.findMany({
            where: { jdText: { not: null } },
            orderBy: { createdAt: "desc" },
            take: PRIOR_JD_LIMIT,
            select: { jdText: true },
          }),
        ]);
        return {
          org: orgRow,
          priorJdExamples: jobs
            .map((j) => j.jdText)
            .filter((t): t is string => typeof t === "string" && t.length > 0),
        };
      });

      const req = WriteJobDescriptionRequest.parse({
        orgId,
        roleTitle: body.roleTitle,
        seniority: body.seniority ?? null,
        department: body.department ?? null,
        teamContext: body.teamContext ?? null,
        hiringManagerNotes: body.hiringManagerNotes ?? null,
        orgContext: buildOrgContext(org, role),
        priorJdExamples,
      });

      return aiClient.writeJd(req);
    },
  );

  // ── 2b — Candidate Outreach Generator ───────────────────────────────────────
  r.post(
    "/applications/:id/outreach",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["copilot"],
        summary: "Generate personalised candidate outreach (Module 2b).",
        description:
          "Loads the application + candidate (parsed profile required) + job + org + the current recruiter's name, then asks the AI service for tone-variant outreach (warm/formal/brief) + InMail + subject A/B options. Requires a parsed profile (400 otherwise). Audited.",
        params: ApplicationIdParam,
        response: {
          200: OutreachResult,
          400: ApiError,
          401: ApiError,
          404: ApiError,
          502: ApiError,
        },
      },
    },
    async (request) => {
      const { orgId, userId, role } = tenant(request);
      const { id } = request.params;

      // Phase 1: load everything under RLS (cross-org rows are invisible → 404).
      const loaded = await withTenant(orgId, async (tx) => {
        const application = await tx.application.findUnique({ where: { id } });
        if (!application) return null;

        const [candidate, job, org, recruiter] = await Promise.all([
          tx.candidate.findUnique({ where: { id: application.candidateId } }),
          tx.jobOpening.findUnique({ where: { id: application.jobId } }),
          tx.organisation.findUnique({ where: { id: orgId } }),
          // The acting recruiter's display name personalises the signature.
          tx.user.findUnique({ where: { id: userId }, select: { name: true } }),
        ]);
        if (!candidate || !job) return null;
        return { application, candidate, job, org, recruiter };
      });

      if (!loaded) throw notFound(`Application ${id} not found`);

      // The outreach references concrete resume details, so a parsed profile is
      // required (spec 2b: "reference specific resume detail"). No profile → 400.
      if (loaded.candidate.profile == null) {
        throw badRequest(
          "Candidate has no parsed profile yet; run the resume pipeline before generating outreach.",
        );
      }

      const profile = CandidateProfile.parse(loaded.candidate.profile);
      // The acting recruiter's display name signs the outreach. Fall back to a
      // neutral default if the acting user has no users-table row (e.g. the dev
      // header path uses a synthetic userId that may not exist).
      const recruiterName = loaded.recruiter?.name ?? "The hiring team";

      const req = GenerateOutreachRequest.parse({
        orgId,
        jobId: loaded.job.id,
        candidateId: loaded.candidate.id,
        profile,
        jobTitle: loaded.job.title,
        jobSummary:
          loaded.job.jdStructured == null
            ? null
            : (JDStructured.parse(loaded.job.jdStructured).teamContext ?? null),
        recruiterName,
        orgContext: buildOrgContext(loaded.org, role),
        // tones omitted → AI service defaults to WARM/FORMAL/BRIEF.
      });

      // Phase 2: call the AI service (validated request + response).
      const result = await aiClient.outreach(req);

      // Phase 3: audit the generation (no message bodies in the payload — keep it
      // a minimal, non-PII decision record; the drafts live only in the response).
      await withTenant(orgId, async (tx) => {
        await writeAudit(tx, {
          actorId: userId,
          action: "copilot.outreach.generate",
          entityType: "application",
          entityId: id,
          payload: {
            candidateId: loaded.candidate.id,
            jobId: loaded.job.id,
            tones: result.variants.map((v) => v.tone),
            modelVersion: result.modelVersion,
            biasIndicatorsDetected: result.biasCheck.biasIndicatorsDetected.length,
          },
          ip: request.ip,
        });
      });

      return result;
    },
  );

  // ── 2c — Recruiter Chat Assistant ───────────────────────────────────────────
  r.post(
    "/copilot/chat",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["copilot"],
        summary: "Recruiter chat assistant (Module 2c — LangGraph ReAct agent).",
        description:
          "Forwards the conversation to the AI service's ReAct agent. The orgId is taken from the authenticated session (NEVER the body) and the agent's tools call back into this API's secret-authenticated /internal/copilot/* router with that same orgId. Returns a CoT-free answer + a summarised tool trace.",
        body: ChatBody,
        response: { 200: RecruiterChatResponse, 400: ApiError, 401: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      const { messages, jobId } = request.body;

      // orgId from the SESSION — never from the body. userRole frames the agent's
      // tone/permissions. The AI service propagates orgId to its internal tools.
      const req = RecruiterChatRequest.parse({
        orgId,
        userRole: role,
        messages,
        jobId: jobId ?? null,
      });

      return aiClient.chat(req);
    },
  );

  // ── 2d — LinkedIn sidebar: analyse a scraped profile vs open roles ───────────
  r.post(
    "/copilot/linkedin/analyze",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["copilot"],
        summary: "Analyse a scraped LinkedIn profile vs open roles (Module 2d).",
        description:
          "Consent is mandatory (400 if consent !== true). Loads the org's OPEN job openings as the roles[] to benchmark against (the AI service cannot query the DB), then returns a structured CandidateProfile, per-role match scores, and a biasCheck. Read-only — does NOT persist a candidate (use /add-to-pool for that).",
        body: LinkedInAnalyzeBody,
        response: { 200: AnalyzeLinkedInResponse, 400: ApiError, 401: ApiError, 502: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      const { profile, consent } = request.body;

      // Consent gate (spec 2d: "scrape LinkedIn profiles with consent"). The
      // downstream contract is `consent: literal(true)`, but we reject early with a
      // clear 400 rather than a generic AI-request validation error.
      if (consent !== true) {
        throw badRequest("Consent is required to analyse a LinkedIn profile.");
      }

      // Load the org's OPEN roles to benchmark against.
      const roles = await withTenant(orgId, async (tx) => {
        const jobs = await tx.jobOpening.findMany({
          where: { status: "OPEN" },
          orderBy: { createdAt: "desc" },
          select: { id: true, title: true, jdText: true, jdStructured: true },
        });
        return jobs.map((j) =>
          LinkedInMatchRole.parse({
            jobId: j.id,
            title: j.title,
            jdText: j.jdText,
            jdStructured: j.jdStructured == null ? null : JDStructured.parse(j.jdStructured),
          }),
        );
      });

      const req = AnalyzeLinkedInRequest.parse({
        orgId,
        profile,
        consent: true,
        roles,
      });

      return aiClient.analyzeLinkedIn(req);
    },
  );

  // ── 2d — LinkedIn sidebar: add a scraped profile to the candidate pool ───────
  r.post(
    "/copilot/linkedin/add-to-pool",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["copilot"],
        summary: "Add a scraped LinkedIn profile to the candidate pool (Module 2d).",
        description:
          "Consent is mandatory (400 if consent !== true). Maps the scraped profile to a Candidate (source LINKEDIN) and creates it under the caller's org (orgId set → RLS WITH CHECK). Audited. Returns the new candidate id + createdAt.",
        body: AddToPoolRequest,
        response: { 201: AddToPoolResponse, 400: ApiError, 401: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, userId } = tenant(request);
      const { profile, consent, source } = request.body;

      if (consent !== true) {
        throw badRequest("Consent is required to add a LinkedIn profile to the pool.");
      }

      const created = await withTenant(orgId, async (tx) => {
        const candidate = await tx.candidate.create({
          data: {
            orgId,
            name: profile.name ?? null,
            // The scrape does not expose contact details; they enrich later.
            email: null,
            phone: null,
            linkedinUrl: profile.url,
            githubUrl: null,
            source,
            resumeFilePath: null,
            // Map the scrape into the canonical structured profile (not resume-parsed,
            // so resumeParsedAt stays null). Cast to the Json input type as elsewhere
            // (e.g. ranking.ts persists validated objects to Json columns the same way).
            profile: linkedInToCandidateProfile(profile) as unknown as Prisma.InputJsonValue,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "copilot.linkedin.add_to_pool",
          entityType: "candidate",
          entityId: candidate.id,
          // Minimal payload: source + consent fact, no scraped PII beyond source.
          payload: { source: candidate.source, consent: true, via: "linkedin_sidebar" },
          ip: request.ip,
        });
        return candidate;
      });

      // serializeCandidate validates the full row against the contract; the response
      // schema only needs id + createdAt, but reusing it keeps the mapping honest.
      const serialized = serializeCandidate(created);
      return reply.code(201).send(
        AddToPoolResponse.parse({
          candidateId: serialized.id,
          createdAt: serialized.createdAt,
        }),
      );
    },
  );
};

export default copilotRoutes;
