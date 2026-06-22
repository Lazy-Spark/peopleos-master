import { z } from "zod";
import { IsoDateTime, JobId, JobStatus, JobType, OrgId, RoleLevel, UserId } from "./common.js";

/**
 * JDStructured — the structured parse of a free-text job description
 * (spec Module 1 step 1: produced via tool_use, not free-form text).
 */
export const RequiredSkill = z.object({
  canonicalName: z.string(),
  importance: z.enum(["CRITICAL", "PREFERRED"]),
});
export type RequiredSkill = z.infer<typeof RequiredSkill>;

export const JDStructured = z.object({
  requiredSkills: z.array(RequiredSkill).default([]),
  preferredSkills: z.array(z.string()).default([]),
  requiredYoe: z.number().min(0).nullable(),
  niceToHaveYoe: z.number().min(0).nullable(),
  roleLevel: RoleLevel.nullable(),
  keyResponsibilities: z.array(z.string()).default([]),
  teamContext: z.string().nullable(),
  reportingStructure: z.string().nullable(),
});
export type JDStructured = z.infer<typeof JDStructured>;

export const JobOpening = z.object({
  id: JobId,
  orgId: OrgId,
  title: z.string().min(1),
  department: z.string().nullable(),
  level: RoleLevel.nullable(),
  location: z.string().nullable(),
  type: JobType,
  status: JobStatus,
  jdText: z.string().nullable(),
  jdStructured: JDStructured.nullable(),
  hiringManagerId: UserId.nullable(),
  recruiterId: UserId.nullable(),
  scorecardTemplateId: z.string().uuid().nullable(),
  createdAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
});
export type JobOpening = z.infer<typeof JobOpening>;

export const JobOpeningCreate = JobOpening.pick({
  title: true,
  department: true,
  level: true,
  location: true,
  type: true,
  jdText: true,
  hiringManagerId: true,
  recruiterId: true,
}).partial({
  department: true,
  level: true,
  location: true,
  jdText: true,
  hiringManagerId: true,
  recruiterId: true,
});
export type JobOpeningCreate = z.infer<typeof JobOpeningCreate>;
