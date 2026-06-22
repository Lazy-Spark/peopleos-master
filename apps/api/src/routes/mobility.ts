import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  CreateGigRequest,
  CreateInternalApplicationRequest,
  Gig,
  GigInterestStatus,
  GigStatus,
  InternalApplication,
  InternalApplicationView,
  InternalAppStatus,
  MobilityAnalytics,
  MobilityEmployeeContext,
  MobilityRecommendRequest,
  MobilityRecommendResponse,
  Readiness,
  RecommendedGigs,
  RecommendedRoles,
  RoleLevel,
  RoleMatchResult,
  SuccessionPlan,
  type Gig as TGig,
  type InternalApplicationView as TInternalApplicationView,
} from "@peopleos/schemas";
import { Prisma } from "@prisma/client";
import type { Gig as PrismaGig, InternalApplication as PrismaInternalApplication } from "@prisma/client";
import { withTenant } from "../db.js";
import type { TxClient } from "../db.js";
import { requireTenant, tenant } from "../plugins/tenancy.js";
import type { AuthContext } from "../plugins/auth.js";
import { writeAudit } from "../lib/audit.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { aiClient } from "../lib/aiClient.js";
import { buildOrgContext } from "../lib/orgContext.js";
import {
  internalCandidates,
  mobilityAnalytics,
  readinessFor,
  recommendedGigs,
  recommendedRoles,
  successionPlan,
} from "../lib/mobilityMatch.js";
import { skillGap } from "../lib/skillGraph.js";

/**
 * Module 8 — Internal Talent Marketplace routes. Mounted under /api/v1, tenant-scoped
 * via requireTenant + withTenant(orgId) (RLS isolates all mobility data per org).
 *
 *   GET   /employees/:id/recommended-roles    RecommendedRoles                  (8a)
 *   POST  /internal-applications              apply for SELF (acting employee)  (8a)
 *   GET   /internal-applications              InternalApplicationView[]         (8a)
 *   PATCH /internal-applications/:id          move along the pipeline
 *   GET   /jobs/:id/internal-candidates       RoleMatchResult ("who can fill?") (8b)
 *   GET   /jobs/:id/succession                SuccessionPlan                    (8d)
 *   GET   /mobility/analytics                 MobilityAnalytics
 *   GET   /gigs                               Gig[]                             (8c)
 *   POST  /gigs                               create a gig                      (8c)
 *   POST  /gigs/:id/interest                  express interest (acting employee)(8c)
 *   GET   /employees/:id/recommended-gigs     RecommendedGigs                   (8c)
 *   GET   /employees/:id/mobility-fit         match + AI move recommendation
 *
 * MATCHING is SKILL-GRAPH driven (src/lib/mobilityMatch.ts → reuses Module 6's
 * skillGap): matchScore = coverage, readiness banded over coverage + gap size.
 *
 * GOVERNANCE (enforced at the route boundary):
 *   - Flight risk is the Module 7 attrition TIER ONLY (never the raw score), surfaced
 *     on internal candidates ONLY to ADMIN/HRBP viewers (null for everyone else).
 *     Succession (which always carries the tier) is ADMIN/HRBP-only.
 *   - An employee acts on their OWN behalf: applying / expressing interest resolves the
 *     ACTING employee from the session principal (never a client-supplied employeeId),
 *     mirroring routes/attrition.ts. An EMPLOYEE may read only their OWN recommendations
 *     and applications; people-ops roles may read anyone's.
 *   - Every query goes through withTenant; every create sets orgId.
 */

const EmployeeIdParam = z.object({ id: z.string().uuid() });
const JobIdParam = z.object({ id: z.string().uuid() });
const InternalApplicationIdParam = z.object({ id: z.string().uuid() });
const GigIdParam = z.object({ id: z.string().uuid() });
const MobilityFitQuery = z.object({ jobOpeningId: z.string().uuid() });

const InternalApplicationListResponse = z.object({
  items: z.array(InternalApplicationView),
});
const GigListResponse = z.object({ items: z.array(Gig) });

/**
 * The skill-graph match facts for an (employee, role) pair (an InternalCandidate-like
 * shape without PII / flight-risk), returned by GET …/mobility-fit alongside the AI rec.
 */
const MobilityFitMatch = z.object({
  matchScore: z.number().min(0).max(1),
  readiness: Readiness,
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  gapSize: z.number().int().nonnegative(),
});

/** The combined match + AI move-recommendation payload for GET …/mobility-fit. */
const MobilityFitResponse = z.object({
  jobOpeningId: z.string().uuid(),
  match: MobilityFitMatch,
  recommendation: MobilityRecommendResponse,
});

/** Roles that may move an internal application along the pipeline / view all applications. */
const PIPELINE_ADMIN_ROLES = new Set(["ADMIN", "HRBP", "RECRUITER"]);
/** Roles that may view "who can fill this role" internal candidates (people-ops + managers). */
const CANDIDATE_VIEW_ROLES = new Set(["ADMIN", "HRBP", "RECRUITER", "MANAGER"]);
/** Roles that may see the attrition flight-risk TIER on candidates (Module 7 governance). */
const FLIGHT_RISK_ROLES = new Set(["ADMIN", "HRBP"]);
/** Roles that may view succession plans + mobility analytics (leadership). */
const SUCCESSION_ROLES = new Set(["ADMIN", "HRBP"]);
/** Roles that may read ANY employee's recommendations (else: own only). */
const PEOPLE_OPS_ROLES = new Set(["ADMIN", "HRBP", "RECRUITER"]);
/** Roles that may create a gig (people-ops + managers post stretch work). */
const GIG_CREATE_ROLES = new Set(["ADMIN", "HRBP", "MANAGER"]);

/** A Prisma InternalApplication row → the bare `InternalApplication` wire contract. */
function serializeInternalApplication(row: PrismaInternalApplication): z.infer<typeof InternalApplication> {
  return InternalApplication.parse({
    id: row.id,
    orgId: row.orgId,
    employeeId: row.employeeId,
    jobOpeningId: row.jobOpeningId,
    status: InternalAppStatus.parse(row.status),
    matchScore: row.matchScore,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** A Prisma Gig row → the `Gig` wire contract (status narrowed through its enum). */
function serializeGig(row: PrismaGig): TGig {
  return Gig.parse({
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    description: row.description,
    requiredSkills: row.requiredSkills,
    // Defensive: the contract requires positive-or-null; coerce a malformed stored
    // 0/negative to null so a bad row can never throw a ZodError on an otherwise-valid read.
    durationWeeks: row.durationWeeks && row.durationWeeks > 0 ? row.durationWeeks : null,
    status: GigStatus.parse(row.status),
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Narrow a free-string DB level column → RoleLevel (null-tolerant). */
function level(raw: string | null): z.infer<typeof RoleLevel> | null {
  if (raw == null) return null;
  const parsed = RoleLevel.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve the ACTING employee's id from the session principal, mirroring the manager
 * resolution in routes/attrition.ts. In prod the principal is a Clerk id → map it to
 * the internal User.id; in dev the principal IS the internal User.id. Employee.userId
 * links the person to that user. Throws 403 if the caller has no Employee record (they
 * cannot act on their own behalf in the marketplace).
 */
async function resolveActingEmployeeId(tx: TxClient, auth: AuthContext): Promise<string> {
  let internalUserId = auth.userId;
  if (auth.source === "clerk") {
    const u = await tx.user.findFirst({
      where: { clerkUserId: auth.userId },
      select: { id: true },
    });
    if (!u) throw forbidden("No employee record is linked to your account.");
    internalUserId = u.id;
  }
  const me = await tx.employee.findFirst({
    where: { userId: internalUserId },
    select: { id: true },
  });
  if (!me) throw forbidden("No employee record is linked to your account.");
  return me.id;
}

const mobilityRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── 8a — Recommended roles for an employee ──────────────────────────────────
  r.get(
    "/employees/:id/recommended-roles",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Recommended internal roles for an employee (Module 8a).",
        description:
          "Ranks the org's OPEN JobOpenings by how well the employee's skills cover each role's required skills (skill-graph driven: matchScore = coverage, readiness banded over coverage + gap size), with `alreadyApplied` set from existing internal applications. An EMPLOYEE may view only their OWN recommendations; ADMIN/HRBP/RECRUITER may view any employee's.",
        params: EmployeeIdParam,
        response: { 200: RecommendedRoles, 401: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      const { id: employeeId } = request.params;

      return withTenant(orgId, async (tx) => {
        await assertCanReadEmployee(tx, auth, employeeId, role);
        return recommendedRoles(tx, employeeId);
      });
    },
  );

  // ── 8a — Apply for an internal role (the ACTING employee, for THEMSELVES) ────
  r.post(
    "/internal-applications",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Apply / express interest in an internal role — for YOURSELF (Module 8a).",
        description:
          "The ACTING employee applies for an internal role on their OWN behalf: the employee is resolved from the session principal (never a client-supplied id), mirroring the attrition route. The skill-graph matchScore is computed and STORED at apply time (advisory, recomputable). Status starts APPLIED. 409 if you already have an application for this role; 404 if the role is not in this tenant.",
        body: CreateInternalApplicationRequest,
        response: {
          201: InternalApplication,
          401: ApiError,
          403: ApiError,
          404: ApiError,
          409: ApiError,
        },
      },
    },
    async (request, reply) => {
      const auth = tenant(request);
      const { orgId } = auth;
      const { jobOpeningId, note } = request.body;

      const created = await withTenant(orgId, async (tx) => {
        // The acting employee applies for THEMSELVES — resolved from the session.
        const employeeId = await resolveActingEmployeeId(tx, auth);

        // The role must exist in this tenant (RLS-scoped) → clean 404 not an FK error.
        const job = await tx.jobOpening.findUnique({
          where: { id: jobOpeningId },
          select: { id: true },
        });
        if (!job) throw notFound(`Role ${jobOpeningId} not found`);

        // One application per (employee, role): a duplicate is a clean 409.
        const existing = await tx.internalApplication.findUnique({
          where: { employeeId_jobOpeningId: { employeeId, jobOpeningId } },
          select: { id: true },
        });
        if (existing) {
          throw conflict("You already have an internal application for this role.");
        }

        // Compute + STORE the skill-graph match score at apply time (advisory).
        const gap = await skillGap(tx, employeeId, jobOpeningId);

        const application = await tx.internalApplication.create({
          data: {
            orgId,
            employeeId,
            jobOpeningId,
            status: InternalAppStatus.enum.APPLIED,
            matchScore: gap.coverage,
            note: note ?? null,
          },
        });
        await writeAudit(tx, {
          actorId: auth.userId,
          action: "internalApplication.create",
          entityType: "internal_application",
          entityId: application.id,
          payload: { jobOpeningId, status: application.status, matchScore: gap.coverage },
          ip: request.ip,
        });
        return application;
      });

      return reply.code(201).send(serializeInternalApplication(created));
    },
  );

  // ── 8a — List internal applications (people-ops: all; employee: own) ─────────
  r.get(
    "/internal-applications",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "List internal applications (Module 8a).",
        description:
          "ADMIN/HRBP/RECRUITER see ALL internal applications in the org; an EMPLOYEE (or any other role) sees only their OWN (resolved from the session principal). Returns joined `InternalApplicationView` rows (job title + employee name), newest first.",
        response: { 200: InternalApplicationListResponse, 401: ApiError, 403: ApiError },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;

      return withTenant(orgId, async (tx) => {
        const seeAll = PIPELINE_ADMIN_ROLES.has(role);
        // Non-people-ops roles see only their OWN applications (resolve acting employee).
        const employeeFilter: Prisma.InternalApplicationWhereInput = seeAll
          ? {}
          : { employeeId: await resolveActingEmployeeId(tx, auth) };

        const rows = await tx.internalApplication.findMany({
          where: employeeFilter,
          include: {
            job: { select: { title: true } },
            employee: { select: { name: true } },
          },
          orderBy: { createdAt: "desc" },
        });

        const items: TInternalApplicationView[] = rows.map((row) =>
          InternalApplicationView.parse({
            id: row.id,
            jobOpeningId: row.jobOpeningId,
            jobTitle: row.job.title,
            employeeId: row.employeeId,
            employeeName: row.employee.name,
            status: InternalAppStatus.parse(row.status),
            matchScore: row.matchScore,
            note: row.note,
            createdAt: row.createdAt.toISOString(),
          }),
        );
        return { items };
      });
    },
  );

  // ── 8a — Move an internal application along the pipeline (recruiter/HRBP/ADMIN)
  r.patch(
    "/internal-applications/:id",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Update an internal application's status (Module 8a) — ADMIN/HRBP/RECRUITER.",
        description:
          "Moves an internal application along the pipeline (INTERESTED → APPLIED → SHORTLISTED → HIRED, or WITHDRAWN / REJECTED). A HIRED status is what feeds the org's internal-mobility metrics (Module 5 5b). Returns the joined `InternalApplicationView`. 404 if not in this tenant.",
        params: InternalApplicationIdParam,
        body: z.object({ status: InternalAppStatus }),
        response: {
          200: InternalApplicationView,
          401: ApiError,
          403: ApiError,
          404: ApiError,
        },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      if (!PIPELINE_ADMIN_ROLES.has(role)) {
        throw forbidden("Only ADMIN, HRBP, or RECRUITER roles may update an internal application.");
      }
      const { id } = request.params;
      const { status } = request.body;

      return withTenant(orgId, async (tx) => {
        const existing = await tx.internalApplication.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!existing) throw notFound(`Internal application ${id} not found`);

        const updated = await tx.internalApplication.update({
          where: { id },
          data: { status },
          include: {
            job: { select: { title: true } },
            employee: { select: { name: true } },
          },
        });
        await writeAudit(tx, {
          actorId: auth.userId,
          action: "internalApplication.updateStatus",
          entityType: "internal_application",
          entityId: updated.id,
          payload: { status },
          ip: request.ip,
        });

        return InternalApplicationView.parse({
          id: updated.id,
          jobOpeningId: updated.jobOpeningId,
          jobTitle: updated.job.title,
          employeeId: updated.employeeId,
          employeeName: updated.employee.name,
          status: InternalAppStatus.parse(updated.status),
          matchScore: updated.matchScore,
          note: updated.note,
          createdAt: updated.createdAt.toISOString(),
        });
      });
    },
  );

  // ── 8b — Internal candidates for a role ("who can fill this role?") ──────────
  r.get(
    "/jobs/:id/internal-candidates",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Who internally could fill this role? (Module 8b) — ADMIN/HRBP/RECRUITER/MANAGER.",
        description:
          "Ranks ACTIVE employees by how well they cover the role's required skills (skill-graph driven). Each candidate's `flightRisk` is the Module 7 attrition TIER ONLY (never the raw score) and is attached ONLY for ADMIN/HRBP viewers — `null` for RECRUITER/MANAGER (governance). 404 if the role is not in this tenant.",
        params: JobIdParam,
        response: { 200: RoleMatchResult, 401: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      if (!CANDIDATE_VIEW_ROLES.has(role)) {
        throw forbidden(
          "Only ADMIN, HRBP, RECRUITER, or MANAGER roles may view internal candidates for a role.",
        );
      }
      const { id: jobOpeningId } = request.params;
      // Flight-risk tier is surfaced ONLY to ADMIN/HRBP viewers (Module 7 governance).
      const includeFlightRisk = FLIGHT_RISK_ROLES.has(role);

      return withTenant(orgId, (tx) => internalCandidates(tx, jobOpeningId, includeFlightRisk));
    },
  );

  // ── 8d — Succession plan for a role (ADMIN/HRBP) ─────────────────────────────
  r.get(
    "/jobs/:id/succession",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Succession plan for a role (Module 8d) — ADMIN/HRBP.",
        description:
          "The internal bench for a (typically senior/critical) role, ranked by readiness, with readyNow / readySoon counts and benchStrength (# candidates with any skill overlap). Each successor carries the Module 7 attrition TIER (succession is ADMIN/HRBP-only, so the tier is always surfaced to this leadership view). 404 if the role is not in this tenant.",
        params: JobIdParam,
        response: { 200: SuccessionPlan, 401: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      if (!SUCCESSION_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may view a succession plan.");
      }
      const { id: jobOpeningId } = request.params;
      return withTenant(orgId, (tx) => successionPlan(tx, jobOpeningId));
    },
  );

  // ── Mobility analytics (ADMIN/HRBP) ──────────────────────────────────────────
  r.get(
    "/mobility/analytics",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Internal-mobility analytics (Module 8) — ADMIN/HRBP.",
        description:
          "Org-wide internal-mobility metrics from internal applications: internalFillRate (internal hires ÷ internal applications), internalMobilityRate (internal hires ÷ active headcount), openInternalRoles, totalInternalApplications, hiredInternally, and internal hires byDepartment. Every ratio guards divide-by-zero (null rather than NaN).",
        response: { 200: MobilityAnalytics, 401: ApiError, 403: ApiError },
      },
    },
    async (request) => {
      const { orgId, role } = tenant(request);
      if (!SUCCESSION_ROLES.has(role)) {
        throw forbidden("Only ADMIN or HRBP roles may view mobility analytics.");
      }
      return withTenant(orgId, (tx) => mobilityAnalytics(tx));
    },
  );

  // ── 8c — Gigs: list ──────────────────────────────────────────────────────────
  r.get(
    "/gigs",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "List the org's gigs / stretch assignments (Module 8c).",
        description: "Lists every gig in the org (OPEN first, then by creation time, newest first).",
        response: { 200: GigListResponse, 401: ApiError },
      },
    },
    async (request) => {
      const { orgId } = tenant(request);
      return withTenant(orgId, async (tx) => {
        const rows = await tx.gig.findMany({
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        });
        return { items: rows.map(serializeGig) };
      });
    },
  );

  // ── 8c — Gigs: create (ADMIN/HRBP/MANAGER) ───────────────────────────────────
  r.post(
    "/gigs",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Create a gig / stretch assignment (Module 8c) — ADMIN/HRBP/MANAGER.",
        description:
          "Posts a short-term internal project. `createdById` records the acting user. Status starts OPEN.",
        body: CreateGigRequest,
        response: { 201: Gig, 400: ApiError, 401: ApiError, 403: ApiError },
      },
    },
    async (request, reply) => {
      const { orgId, userId, role } = tenant(request);
      if (!GIG_CREATE_ROLES.has(role)) {
        throw forbidden("Only ADMIN, HRBP, or MANAGER roles may create a gig.");
      }
      const body = request.body;

      const created = await withTenant(orgId, async (tx) => {
        const gig = await tx.gig.create({
          data: {
            orgId,
            title: body.title,
            description: body.description,
            requiredSkills: body.requiredSkills,
            durationWeeks: body.durationWeeks ?? null,
            status: GigStatus.enum.OPEN,
            createdById: userId,
          },
        });
        await writeAudit(tx, {
          actorId: userId,
          action: "gig.create",
          entityType: "gig",
          entityId: gig.id,
          payload: { title: gig.title, requiredSkills: gig.requiredSkills },
          ip: request.ip,
        });
        return gig;
      });

      return reply.code(201).send(serializeGig(created));
    },
  );

  // ── 8c — Gigs: express interest (the ACTING employee, for THEMSELVES) ─────────
  r.post(
    "/gigs/:id/interest",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Express interest in a gig — for YOURSELF (Module 8c).",
        description:
          "The ACTING employee expresses interest in a gig on their OWN behalf: the employee is resolved from the session principal (never a client-supplied id). 409 if you already expressed interest; 404 if the gig is not in this tenant.",
        params: GigIdParam,
        response: {
          201: z.object({ gigId: z.string().uuid(), employeeId: z.string().uuid(), status: GigInterestStatus }),
          401: ApiError,
          403: ApiError,
          404: ApiError,
          409: ApiError,
        },
      },
    },
    async (request, reply) => {
      const auth = tenant(request);
      const { orgId } = auth;
      const { id: gigId } = request.params;

      const result = await withTenant(orgId, async (tx) => {
        // The acting employee expresses interest for THEMSELVES — resolved from session.
        const employeeId = await resolveActingEmployeeId(tx, auth);

        const gig = await tx.gig.findUnique({ where: { id: gigId }, select: { id: true } });
        if (!gig) throw notFound(`Gig ${gigId} not found`);

        const existing = await tx.gigInterest.findUnique({
          where: { gigId_employeeId: { gigId, employeeId } },
          select: { id: true },
        });
        if (existing) throw conflict("You have already expressed interest in this gig.");

        const interest = await tx.gigInterest.create({
          data: { orgId, gigId, employeeId, status: GigInterestStatus.enum.INTERESTED },
        });
        await writeAudit(tx, {
          actorId: auth.userId,
          action: "gigInterest.create",
          entityType: "gig_interest",
          entityId: interest.id,
          payload: { gigId },
          ip: request.ip,
        });
        return { gigId, employeeId, status: GigInterestStatus.enum.INTERESTED };
      });

      return reply.code(201).send(result);
    },
  );

  // ── 8c — Recommended gigs for an employee ────────────────────────────────────
  r.get(
    "/employees/:id/recommended-gigs",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "Recommended gigs for an employee (Module 8c).",
        description:
          "Ranks OPEN gigs by how well the employee's skills cover each gig's requiredSkills. An EMPLOYEE may view only their OWN; ADMIN/HRBP/RECRUITER may view any employee's.",
        params: EmployeeIdParam,
        response: { 200: RecommendedGigs, 401: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      const { id: employeeId } = request.params;

      return withTenant(orgId, async (tx) => {
        await assertCanReadEmployee(tx, auth, employeeId, role);
        return recommendedGigs(tx, employeeId);
      });
    },
  );

  // ── Mobility fit: skill match + AI move recommendation ───────────────────────
  r.get(
    "/employees/:id/mobility-fit",
    {
      preHandler: requireTenant,
      schema: {
        tags: ["mobility"],
        summary: "An employee's fit for a target role + AI move recommendation (Module 8).",
        description:
          "Computes the skill-graph match for the (employee, target role) pair (matchScore = coverage, readiness, matched/missing skills, gapSize), then asks the AI service (Claude claude-sonnet-4-6) for a grounded move recommendation: a fit summary + a per-missing-skill development plan, grounded ONLY in the supplied skills + readiness (prompt standard #2) with a biasCheck (prompt standard #4). The AI employee context is NON-PII (role title / level / department — never name/demographics). An EMPLOYEE may view only their OWN; ADMIN/HRBP/RECRUITER may view any employee's. 502 if the AI service is unavailable.",
        params: EmployeeIdParam,
        querystring: MobilityFitQuery,
        response: {
          200: MobilityFitResponse,
          401: ApiError,
          403: ApiError,
          404: ApiError,
          502: ApiError,
        },
      },
    },
    async (request) => {
      const auth = tenant(request);
      const { orgId, role } = auth;
      const { id: employeeId } = request.params;
      const { jobOpeningId } = request.query;

      // Compute the match + gather the (NON-PII) AI inputs inside ONE tenant tx.
      const { match, aiRequest } = await withTenant(orgId, async (tx) => {
        await assertCanReadEmployee(tx, auth, employeeId, role);

        const gap = await skillGap(tx, employeeId, jobOpeningId);
        const readiness = readinessFor(gap.coverage, gap.gapSize);

        // NON-PII employee context for the AI (role title / level / department — never
        // name/demographics), mirroring the attrition explanation's privacy guard.
        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
          select: { roleTitle: true, level: true, department: true },
        });
        const job = await tx.jobOpening.findUnique({
          where: { id: jobOpeningId },
          select: { title: true },
        });
        const org = await tx.organisation.findUnique({ where: { id: orgId } });

        const matchPayload = {
          matchScore: gap.coverage,
          readiness,
          matchedSkills: gap.matched,
          missingSkills: gap.missing,
          gapSize: gap.gapSize,
        };
        const aiReq = MobilityRecommendRequest.parse({
          orgId,
          targetRoleTitle: job?.title ?? gap.targetRoleTitle,
          requiredSkills: gap.requiredSkills,
          matchedSkills: gap.matched,
          missingSkills: gap.missing,
          readiness,
          employeeContext: MobilityEmployeeContext.parse({
            roleTitle: employee?.roleTitle ?? null,
            level: level(employee?.level ?? null),
            department: employee?.department ?? null,
          }),
          orgContext: buildOrgContext(org, role),
        });
        return { match: matchPayload, aiRequest: aiReq };
      });

      const recommendation = await aiClient.recommendMove(aiRequest);

      return MobilityFitResponse.parse({ jobOpeningId, match, recommendation });
    },
  );
};

/**
 * Assert the caller may read the target employee's recommendations. PEOPLE_OPS roles
 * (ADMIN/HRBP/RECRUITER) may read anyone's; everyone else (incl. EMPLOYEE/MANAGER) may
 * read only their OWN (the acting employee resolved from the session principal). The
 * target employee must exist in this tenant (RLS-scoped) → clean 404 otherwise.
 */
async function assertCanReadEmployee(
  tx: TxClient,
  auth: AuthContext,
  employeeId: string,
  role: AuthContext["role"],
): Promise<void> {
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { id: true },
  });
  if (!employee) throw notFound(`Employee ${employeeId} not found`);
  if (PEOPLE_OPS_ROLES.has(role)) return;
  const me = await resolveActingEmployeeId(tx, auth);
  if (me !== employeeId) {
    throw forbidden("You may only view your own internal-mobility recommendations.");
  }
}

export default mobilityRoutes;
