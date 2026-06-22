import { z } from "zod";
import {
  CandidateId,
  CandidateSource,
  IsoDate,
  IsoDateTime,
  OrgId,
  ProficiencyLevel,
  SkillCategory,
} from "./common.js";

/**
 * CandidateProfile — the structured output of the resume pipeline (spec Layer 2A).
 * The AI ranker NEVER sees the raw file; it sees only this structured profile so
 * that name/school/employer can be masked at the bias layer (prompt standard #4).
 */

export const Education = z.object({
  school: z.string(),
  degree: z.string().nullable(),
  field: z.string().nullable(),
  startYear: z.number().int().nullable(),
  endYear: z.number().int().nullable(),
});
export type Education = z.infer<typeof Education>;

export const WorkExperience = z.object({
  company: z.string(),
  title: z.string(),
  startDate: IsoDate.nullable(),
  endDate: IsoDate.nullable(), // null = current
  description: z.string().nullable(),
  /** Computed in pipeline step 4; used by experience-relevance scoring. */
  isCurrent: z.boolean().default(false),
});
export type WorkExperience = z.infer<typeof WorkExperience>;

/** A skill as it appears on a candidate profile, post-normalisation. */
export const CandidateSkill = z.object({
  /** Canonical skill name (mapped to ESCO/org ontology in pipeline step 3). */
  canonicalName: z.string(),
  /** As written on the resume, pre-normalisation (audit/debug). */
  rawName: z.string().nullable(),
  category: SkillCategory,
  proficiency: ProficiencyLevel.nullable(),
  /** Confidence this skill assertion is correct, [0,1]. Resume-inferred = ~0.6. */
  confidence: z.number().min(0).max(1).default(0.6),
});
export type CandidateSkill = z.infer<typeof CandidateSkill>;

export const Certification = z.object({
  name: z.string(),
  issuer: z.string().nullable(),
  year: z.number().int().nullable(),
});
export type Certification = z.infer<typeof Certification>;

export const LanguageProficiency = z.object({
  language: z.string(),
  level: z.string().nullable(), // e.g. "Native", "Fluent", "B2"
});
export type LanguageProficiency = z.infer<typeof LanguageProficiency>;

/** A detected gap or overlap in employment history (pipeline step 4). */
export const ExperienceGap = z.object({
  type: z.enum(["GAP", "OVERLAP"]),
  fromDate: IsoDate,
  toDate: IsoDate,
  months: z.number().min(0),
});
export type ExperienceGap = z.infer<typeof ExperienceGap>;

export const CandidateProfile = z.object({
  name: z.string().nullable(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().url().nullable(),
  githubUrl: z.string().url().nullable(),
  location: z.string().nullable(),
  education: z.array(Education).default([]),
  experience: z.array(WorkExperience).default([]),
  skills: z.array(CandidateSkill).default([]),
  certifications: z.array(Certification).default([]),
  languages: z.array(LanguageProficiency).default([]),
  publications: z.array(z.string()).default([]),
  /** Derived signals from pipeline step 4. */
  gaps: z.array(ExperienceGap).default([]),
  totalYoe: z.number().min(0).nullable(),
});
export type CandidateProfile = z.infer<typeof CandidateProfile>;

/** Candidate entity as persisted (Prisma) and returned by the API. */
export const Candidate = z.object({
  id: CandidateId,
  orgId: OrgId,
  name: z.string().nullable(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().url().nullable(),
  githubUrl: z.string().url().nullable(),
  source: CandidateSource,
  resumeFilePath: z.string().nullable(),
  resumeParsedAt: IsoDateTime.nullable(),
  profile: CandidateProfile.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Candidate = z.infer<typeof Candidate>;

/** Create payload (server assigns id/orgId/timestamps). */
export const CandidateCreate = Candidate.pick({
  name: true,
  email: true,
  phone: true,
  linkedinUrl: true,
  githubUrl: true,
  source: true,
  resumeFilePath: true,
});
export type CandidateCreate = z.infer<typeof CandidateCreate>;
