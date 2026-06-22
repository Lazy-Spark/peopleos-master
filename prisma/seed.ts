/**
 * Seed script — one demo org with users, a job, and candidates.
 * Runs as the Prisma owner role (bypasses RLS), so cross-tenant writes are fine.
 *
 *   pnpm db:seed
 *
 * Fixed UUIDs so you can drive the API locally, e.g.:
 *   curl -H "X-Org-Id: 00000000-0000-0000-0000-000000000001" localhost:3001/api/v1/jobs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const RECRUITER_ID = "00000000-0000-0000-0000-0000000000a1";
const HMANAGER_ID = "00000000-0000-0000-0000-0000000000a2";
const JOB_ID = "00000000-0000-0000-0000-0000000000b1";
const CAND_1 = "00000000-0000-0000-0000-0000000000c1";
const CAND_2 = "00000000-0000-0000-0000-0000000000c2";

async function main() {
  const org = await prisma.organisation.upsert({
    where: { id: ORG_ID },
    update: {},
    create: {
      id: ORG_ID,
      name: "Acme Corp",
      planTier: "GROWTH",
      settings: {
        rankingWeights: { skillMatch: 0.35, expRelevance: 0.3, holistic: 0.25, yoeMatch: 0.1 },
        tonePreferences: "warm, direct",
        universityPrestigeAsFactor: false,
      },
    },
  });

  await prisma.user.upsert({
    where: { id: RECRUITER_ID },
    update: {},
    create: { id: RECRUITER_ID, orgId: org.id, email: "rae@acme.test", name: "Rae Recruiter", role: "RECRUITER" },
  });
  await prisma.user.upsert({
    where: { id: HMANAGER_ID },
    update: {},
    create: { id: HMANAGER_ID, orgId: org.id, email: "max@acme.test", name: "Max Manager", role: "MANAGER" },
  });

  await prisma.jobOpening.upsert({
    where: { id: JOB_ID },
    update: {},
    create: {
      id: JOB_ID,
      orgId: org.id,
      title: "Senior Machine Learning Engineer",
      department: "Engineering",
      level: "SENIOR",
      location: "Remote (EU)",
      type: "FULL_TIME",
      status: "OPEN",
      hiringManagerId: HMANAGER_ID,
      recruiterId: RECRUITER_ID,
      jdText:
        "We are hiring a Senior ML Engineer to build production NLP and ranking systems. " +
        "You'll own model training, evaluation, and deployment. 5+ years building ML systems required.",
      jdStructured: {
        requiredSkills: [
          { canonicalName: "Python", importance: "CRITICAL" },
          { canonicalName: "Machine Learning", importance: "CRITICAL" },
          { canonicalName: "PyTorch", importance: "PREFERRED" },
          { canonicalName: "MLOps", importance: "PREFERRED" },
        ],
        preferredSkills: ["LangChain", "Kubernetes"],
        requiredYoe: 5,
        niceToHaveYoe: 7,
        roleLevel: "SENIOR",
        keyResponsibilities: [
          "Train and evaluate production ML models",
          "Build data and feature pipelines",
          "Deploy and monitor models in production",
        ],
        teamContext: "Joining a 6-person ML platform team",
        reportingStructure: "Reports to the ML Platform Manager",
      },
    },
  });

  await prisma.candidate.upsert({
    where: { id: CAND_1 },
    update: {},
    create: {
      id: CAND_1,
      orgId: org.id,
      name: "Jordan Rivera",
      email: "jordan.rivera@example.test",
      source: "LINKEDIN",
      profile: {
        name: "Jordan Rivera",
        email: "jordan.rivera@example.test",
        phone: null,
        linkedinUrl: null,
        githubUrl: null,
        location: "Berlin, DE",
        education: [{ school: "TU Munich", degree: "MSc", field: "Computer Science", startYear: 2014, endYear: 2016 }],
        experience: [
          {
            company: "DataForge",
            title: "ML Engineer",
            startDate: "2019-03-01",
            endDate: null,
            description: "Built ranking and NLP models in Python/PyTorch; owned MLOps deployment.",
            isCurrent: true,
          },
        ],
        skills: [
          { canonicalName: "Python", rawName: "Python", category: "TECHNICAL", proficiency: "EXPERT", confidence: 0.6 },
          { canonicalName: "Machine Learning", rawName: "ML", category: "TECHNICAL", proficiency: "ADVANCED", confidence: 0.6 },
          { canonicalName: "PyTorch", rawName: "PyTorch", category: "TECHNICAL", proficiency: "ADVANCED", confidence: 0.6 },
        ],
        certifications: [],
        languages: [{ language: "English", level: "Fluent" }],
        publications: [],
        gaps: [],
        totalYoe: 6,
      },
      resumeParsedAt: new Date(),
    },
  });

  await prisma.candidate.upsert({
    where: { id: CAND_2 },
    update: {},
    create: {
      id: CAND_2,
      orgId: org.id,
      name: "Sam Lee",
      email: "sam.lee@example.test",
      source: "REFERRAL",
      profile: {
        name: "Sam Lee",
        email: "sam.lee@example.test",
        phone: null,
        linkedinUrl: null,
        githubUrl: null,
        location: "Lisbon, PT",
        education: [{ school: "Univ. Lisbon", degree: "BSc", field: "Mathematics", startYear: 2017, endYear: 2020 }],
        experience: [
          {
            company: "WebShop",
            title: "Backend Engineer",
            startDate: "2020-09-01",
            endDate: null,
            description: "Python/Django services; some data pipeline work.",
            isCurrent: true,
          },
        ],
        skills: [
          { canonicalName: "Python", rawName: "Python", category: "TECHNICAL", proficiency: "ADVANCED", confidence: 0.6 },
        ],
        certifications: [],
        languages: [{ language: "English", level: "Fluent" }],
        publications: [],
        gaps: [],
        totalYoe: 4,
      },
      resumeParsedAt: new Date(),
    },
  });

  for (const candidateId of [CAND_1, CAND_2]) {
    await prisma.application.upsert({
      where: { candidateId_jobId: { candidateId, jobId: JOB_ID } },
      update: {},
      create: { orgId: org.id, candidateId, jobId: JOB_ID, stage: "SCREENING" },
    });
  }

  // ── Employees (HRMS / Module 5 workforce analytics source) ──────────────────
  // Two managers (Eng span 3 = OK, Sales span 1 = NARROW), varied levels/locations/
  // employment types, and two new hires past their 90-day mark (one strong, one weak)
  // so newHireSuccessRate is computable.
  await prisma.employee.createMany({
    skipDuplicates: true,
    data: [
      // Engineering manager (no manager). userId links Eli to the seeded MANAGER user
      // (Max Manager) so the manager attrition view (tier + recommendation for own
      // reports e2/e3/e4) is reachable/exercisable.
      { id: "00000000-0000-0000-0000-0000000000e1", orgId: org.id, userId: HMANAGER_ID, name: "Eli Manager", department: "Engineering", roleTitle: "Engineering Manager", level: "MANAGER", location: "Remote (EU)", employmentType: "FULL_TIME", hireDate: new Date("2022-03-01"), status: "ACTIVE", lastReviewRating: 4.5, lastPromotionDate: new Date("2024-06-01") },
      // Eng reports (span of control = 3 → OK).
      { id: "00000000-0000-0000-0000-0000000000e2", orgId: org.id, name: "Ada Senior", department: "Engineering", roleTitle: "Senior Engineer", level: "SENIOR", managerId: "00000000-0000-0000-0000-0000000000e1", location: "Berlin, DE", employmentType: "FULL_TIME", hireDate: new Date("2021-09-01"), status: "ACTIVE", lastReviewRating: 4.0, lastPromotionDate: new Date("2023-09-01") },
      { id: "00000000-0000-0000-0000-0000000000e3", orgId: org.id, name: "Ben Mid", department: "Engineering", roleTitle: "Engineer", level: "MID", managerId: "00000000-0000-0000-0000-0000000000e1", location: "Lisbon, PT", employmentType: "FULL_TIME", hireDate: new Date("2026-01-10"), status: "ACTIVE", lastReviewRating: 4.2 },
      { id: "00000000-0000-0000-0000-0000000000e4", orgId: org.id, name: "Cleo Junior", department: "Engineering", roleTitle: "Junior Engineer", level: "JUNIOR", managerId: "00000000-0000-0000-0000-0000000000e1", location: "Remote (EU)", employmentType: "FULL_TIME", hireDate: new Date("2026-02-15"), status: "ACTIVE", lastReviewRating: 2.5 },
      // Sales manager (span of control = 1 → NARROW).
      { id: "00000000-0000-0000-0000-0000000000e5", orgId: org.id, name: "Dana Sales", department: "Sales", roleTitle: "Sales Manager", level: "MANAGER", location: "London, UK", employmentType: "FULL_TIME", hireDate: new Date("2020-01-01"), status: "ACTIVE", lastReviewRating: 4.0 },
      { id: "00000000-0000-0000-0000-0000000000e6", orgId: org.id, name: "Frank Rep", department: "Sales", roleTitle: "Account Executive", level: "MID", managerId: "00000000-0000-0000-0000-0000000000e5", location: "London, UK", employmentType: "CONTRACT", hireDate: new Date("2023-02-01"), status: "ACTIVE", lastReviewRating: 3.5 },
    ],
  });

  // ── Skill graph (Module 6): a small org skill catalog + employee skill records ──
  await prisma.skill.createMany({
    skipDuplicates: true,
    data: [
      { id: "00000000-0000-0000-0000-0000000000f1", orgId: org.id, canonicalName: "Python", aliases: ["py"], category: "TECHNICAL" },
      { id: "00000000-0000-0000-0000-0000000000f2", orgId: org.id, canonicalName: "Machine Learning", aliases: ["ML"], category: "TECHNICAL" },
      { id: "00000000-0000-0000-0000-0000000000f3", orgId: org.id, canonicalName: "PyTorch", aliases: [], category: "TECHNICAL" },
      { id: "00000000-0000-0000-0000-0000000000f4", orgId: org.id, canonicalName: "MLOps", aliases: [], category: "TECHNICAL" },
      { id: "00000000-0000-0000-0000-0000000000f5", orgId: org.id, canonicalName: "Communication", aliases: [], category: "SOFT" },
      { id: "00000000-0000-0000-0000-0000000000f6", orgId: org.id, canonicalName: "Leadership", aliases: [], category: "SOFT" },
      { id: "00000000-0000-0000-0000-0000000000f7", orgId: org.id, canonicalName: "Sales", aliases: [], category: "DOMAIN" },
      { id: "00000000-0000-0000-0000-0000000000f8", orgId: org.id, canonicalName: "Negotiation", aliases: [], category: "SOFT" },
    ],
  });

  // confidence by source: self 0.5 / manager 0.8 / assessment 0.9 / resume 0.6 / project 0.7.
  // Bus-factor skills (held by exactly one): PyTorch (e2), MLOps (e1), Negotiation (e5).
  const rec = (
    employeeId: string,
    skillId: string,
    proficiency: string,
    source: string,
    confidenceScore: number,
  ) => ({ orgId: org.id, employeeId, skillId, proficiency, source, confidenceScore });
  const E = (n: string) => `00000000-0000-0000-0000-0000000000${n}`;
  await prisma.skillRecord.createMany({
    skipDuplicates: true,
    data: [
      rec(E("e1"), E("f1"), "EXPERT", "MANAGER_VERIFIED", 0.8),
      rec(E("e1"), E("f2"), "ADVANCED", "MANAGER_VERIFIED", 0.8),
      rec(E("e1"), E("f4"), "PRACTITIONER", "SELF_REPORTED", 0.5),
      rec(E("e1"), E("f5"), "ADVANCED", "MANAGER_VERIFIED", 0.8),
      rec(E("e1"), E("f6"), "ADVANCED", "MANAGER_VERIFIED", 0.8),
      rec(E("e2"), E("f1"), "EXPERT", "INFERRED_RESUME", 0.6),
      rec(E("e2"), E("f2"), "ADVANCED", "ASSESSMENT_VERIFIED", 0.9),
      rec(E("e2"), E("f3"), "ADVANCED", "INFERRED_RESUME", 0.6),
      rec(E("e3"), E("f1"), "ADVANCED", "SELF_REPORTED", 0.5),
      rec(E("e5"), E("f5"), "EXPERT", "MANAGER_VERIFIED", 0.8),
      rec(E("e5"), E("f7"), "EXPERT", "MANAGER_VERIFIED", 0.8),
      rec(E("e5"), E("f8"), "ADVANCED", "SELF_REPORTED", 0.5),
      rec(E("e5"), E("f6"), "PRACTITIONER", "SELF_REPORTED", 0.5),
      rec(E("e6"), E("f7"), "ADVANCED", "SELF_REPORTED", 0.5),
      rec(E("e6"), E("f5"), "ADVANCED", "SELF_REPORTED", 0.5),
    ],
  });

  // ── Internal mobility (Module 8): an internal application + a gig + interest ──
  await prisma.internalApplication.createMany({
    skipDuplicates: true,
    data: [
      // Ada (strong skill match for the seeded ML role) has applied internally.
      { orgId: org.id, employeeId: E("e2"), jobOpeningId: JOB_ID, status: "APPLIED", matchScore: 0.75 },
    ],
  });
  const gig = await prisma.gig.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000d1" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-0000000000d1",
      orgId: org.id,
      title: "ML platform spike: model registry POC",
      description:
        "A 6-week stretch project to prototype an internal model registry. Great for building MLOps depth.",
      requiredSkills: ["Python", "MLOps"],
      durationWeeks: 6,
      status: "OPEN",
      createdById: HMANAGER_ID,
    },
  });
  await prisma.gigInterest.createMany({
    skipDuplicates: true,
    data: [{ orgId: org.id, gigId: gig.id, employeeId: E("e3"), status: "INTERESTED" }],
  });

  // ── Workflow templates (Module 9): onboarding + offboarding, event-triggered ──
  await prisma.workflowDefinition.upsert({
    where: { id: "00000000-0000-0000-0000-000000009001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000009001",
      orgId: org.id,
      key: "onboarding",
      name: "New Hire Onboarding",
      description: "Runs automatically when an employee is created.",
      trigger: "EVENT",
      eventType: "employee.created",
      createdById: HMANAGER_ID,
      steps: [
        { id: "approve", type: "APPROVAL", name: "Manager approves onboarding", assigneeRole: "MANAGER", slaHours: 48, next: "laptop" },
        { id: "laptop", type: "TASK", name: "IT provisions laptop & accounts", assigneeRole: "ADMIN", slaHours: 72, next: "plan" },
        { id: "plan", type: "AI_TASK", name: "Draft 30-60-90 onboarding plan", config: { prompt: "Draft a 30-60-90 day onboarding plan for the new hire." }, next: "welcome" },
        { id: "welcome", type: "NOTIFICATION", name: "Send welcome email", config: { template: "welcome" }, next: "buddy" },
        { id: "buddy", type: "TASK", name: "Assign onboarding buddy", assigneeRole: "HRBP", slaHours: 120, next: null },
      ],
    },
  });
  await prisma.workflowDefinition.upsert({
    where: { id: "00000000-0000-0000-0000-000000009002" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000009002",
      orgId: org.id,
      key: "offboarding",
      name: "Employee Offboarding",
      description: "Runs automatically when an employee is terminated.",
      trigger: "EVENT",
      eventType: "employee.terminated",
      createdById: HMANAGER_ID,
      steps: [
        { id: "revoke", type: "TASK", name: "Revoke system access", assigneeRole: "ADMIN", slaHours: 24, next: "assets" },
        { id: "assets", type: "TASK", name: "Recover company assets", assigneeRole: "MANAGER", slaHours: 72, next: "exit" },
        { id: "exit", type: "TASK", name: "Conduct exit interview", assigneeRole: "HRBP", slaHours: 120, next: "notify" },
        { id: "notify", type: "NOTIFICATION", name: "Notify payroll & benefits", config: { template: "offboarding_payroll" }, next: null },
      ],
    },
  });

  console.log(
    `Seeded org ${org.id} (${org.name}) with 2 users, 1 job, 2 candidates + applications, 6 employees, 8 skills + records, 1 internal application + 1 gig, 2 workflow templates.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
