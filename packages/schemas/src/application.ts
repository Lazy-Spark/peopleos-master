import { z } from "zod";
import { Candidate } from "./candidate.js";
import {
  ApplicationId,
  ApplicationStage,
  ApplicationStatus,
  CandidateId,
  IsoDateTime,
  JobId,
  OrgId,
  RankingTier,
  UnitScore,
} from "./common.js";

/**
 * Compact AI ranking summary embedded on the Application row (spec data model:
 * Application.ai_ranking{}). The full record lives in `CandidateRanking`.
 */
export const ApplicationAiRanking = z.object({
  score: UnitScore,
  tier: RankingTier,
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  interviewFocus: z.array(z.string()),
  summary: z.string(),
  modelVersion: z.string(),
  scoredAt: IsoDateTime,
});
export type ApplicationAiRanking = z.infer<typeof ApplicationAiRanking>;

export const Application = z.object({
  id: ApplicationId,
  orgId: OrgId,
  candidateId: CandidateId,
  jobId: JobId,
  stage: ApplicationStage,
  status: ApplicationStatus,
  aiRanking: ApplicationAiRanking.nullable(),
  appliedAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Application = z.infer<typeof Application>;

export const ApplicationCreate = z.object({
  candidateId: CandidateId,
  jobId: JobId,
});
export type ApplicationCreate = z.infer<typeof ApplicationCreate>;

export const ApplicationStageUpdate = z.object({
  stage: ApplicationStage,
});
export type ApplicationStageUpdate = z.infer<typeof ApplicationStageUpdate>;

/**
 * An application joined with its candidate — the shape the ATS pipeline / board
 * view consumes. Defined here (not in the web app) so the API response and the web
 * client validate against the SAME contract (GET /api/v1/jobs/:id/applications).
 */
export const PipelineEntry = z.object({
  application: Application,
  candidate: Candidate,
});
export type PipelineEntry = z.infer<typeof PipelineEntry>;
