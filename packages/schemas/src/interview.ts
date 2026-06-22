import { z } from "zod";
import { OrgContext } from "./ai.js";
import {
  ApplicationId,
  Confidence,
  InterviewId,
  IsoDateTime,
  OrgId,
  ScorecardId,
  UnitScore,
  UserId,
} from "./common.js";
import { BiasCheck } from "./ranking.js";

/**
 * Module 3 — Interview Intelligence & Summaries contracts. AI-service-facing shapes
 * are mirrored as Pydantic in services/ai/app/schemas.py; camelCase end-to-end.
 *
 * Privacy: transcripts are sensitive. They are stored encrypted (S3 SSE-KMS), never
 * in plaintext; processing requires candidate consent; deletion is supported via DSAR.
 */

// ═══ Transcript ══════════════════════════════════════════════════════════════
export const SpeakerRole = z.enum(["INTERVIEWER", "CANDIDATE", "UNKNOWN"]);
export type SpeakerRole = z.infer<typeof SpeakerRole>;

export const TranscriptSource = z.enum(["ZOOM", "GOOGLE_MEET", "MS_TEAMS", "UPLOAD"]);
export type TranscriptSource = z.infer<typeof TranscriptSource>;

/** One diarised, timestamped utterance (WhisperX output). */
export const TranscriptSegment = z.object({
  /** Diarisation label, e.g. "Interviewer A", "Candidate". */
  speakerLabel: z.string(),
  speakerRole: SpeakerRole,
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const InterviewTranscript = z.object({
  segments: z.array(TranscriptSegment),
  durationSec: z.number().min(0).nullable(),
  language: z.string().nullable(),
  source: TranscriptSource,
  diarised: z.boolean().default(false),
});
export type InterviewTranscript = z.infer<typeof InterviewTranscript>;

// ═══ Competency / STAR extraction (analyze step 1) ═══════════════════════════
/** STAR completeness per dimension, each in [0,1] (spec: score each dimension). */
export const StarScores = z.object({
  situation: UnitScore,
  task: UnitScore,
  action: UnitScore,
  result: UnitScore,
});
export type StarScores = z.infer<typeof StarScores>;

export const CompetencyEvidence = z.object({
  question: z.string(),
  answerSummary: z.string(),
  behaviouralIndicators: z.array(z.string()).default([]),
  competencyArea: z.string(),
  star: StarScores,
  /** Overall STAR completeness for this answer, [0,1]. */
  starCompleteness: UnitScore,
});
export type CompetencyEvidence = z.infer<typeof CompetencyEvidence>;

// ═══ Scorecard (analyze step 2/3) ════════════════════════════════════════════
/** Mirrors the Prisma ScorecardRecommendation enum. */
export const ScorecardRecommendation = z.enum(["STRONG_YES", "YES", "NO", "STRONG_NO"]);
export type ScorecardRecommendation = z.infer<typeof ScorecardRecommendation>;

/** A role's competency rubric (configured per role; supplied by the API). */
export const ScorecardCompetency = z.object({
  competencyId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
});
export type ScorecardCompetency = z.infer<typeof ScorecardCompetency>;

export const ScorecardTemplate = z.object({
  competencies: z.array(ScorecardCompetency).default([]),
});
export type ScorecardTemplate = z.infer<typeof ScorecardTemplate>;

/** One competency score with a transcript evidence quote (NO score without evidence). */
export const CompetencyScore = z.object({
  competencyId: z.string(),
  competencyName: z.string(),
  score: z.number().int().min(1).max(5),
  /** Verbatim quote from the transcript supporting the score (prompt standard #2). */
  evidenceQuote: z.string(),
  rationale: z.string(),
});
export type CompetencyScore = z.infer<typeof CompetencyScore>;

export const AiScorecardDraft = z.object({
  competencyScores: z.array(CompetencyScore),
  overallRecommendation: ScorecardRecommendation,
  confidence: Confidence,
  keyReasons: z.array(z.string()),
  /** 3-paragraph executive summary (background recap, highlights, concerns/next steps). */
  summary: z.string(),
  biasCheck: BiasCheck,
});
export type AiScorecardDraft = z.infer<typeof AiScorecardDraft>;

// ═══ Calibration (analyze step 4) ════════════════════════════════════════════
export const FlagSeverity = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type FlagSeverity = z.infer<typeof FlagSeverity>;

/** Off-limits / illegal interview topics that must be flagged immediately (spec). */
export const IllegalTopic = z.enum([
  "PREGNANCY",
  "FAMILY_PLANNING",
  "RELIGION",
  "AGE",
  "NATIONALITY",
  "MARITAL_STATUS",
  "HEALTH_DISABILITY",
  "RACE",
  "SEXUAL_ORIENTATION",
  "OTHER",
]);
export type IllegalTopic = z.infer<typeof IllegalTopic>;

export const CalibrationFlagType = z.enum([
  "LEADING_QUESTION",
  "ILLEGAL_QUESTION",
  "SCORE_DIVERGENCE",
]);
export type CalibrationFlagType = z.infer<typeof CalibrationFlagType>;

export const CalibrationFlag = z.object({
  type: CalibrationFlagType,
  severity: FlagSeverity,
  detail: z.string(),
  /** Transcript quote the flag is grounded in (for LEADING/ILLEGAL question flags). */
  evidenceQuote: z.string().nullable(),
  /** Set when type === ILLEGAL_QUESTION. */
  illegalTopic: IllegalTopic.nullable(),
  /** Set when type === SCORE_DIVERGENCE (panel). */
  competencyId: z.string().nullable(),
});
export type CalibrationFlag = z.infer<typeof CalibrationFlag>;

// ═══ AI service contract ═════════════════════════════════════════════════════
export const AnalyzeInterviewRequest = z.object({
  orgId: OrgId,
  interviewId: InterviewId,
  jobTitle: z.string().nullable(),
  scorecardTemplate: ScorecardTemplate,
  transcript: InterviewTranscript,
  orgContext: OrgContext.optional(),
});
export type AnalyzeInterviewRequest = z.infer<typeof AnalyzeInterviewRequest>;

export const AnalyzeInterviewResponse = z.object({
  scorecardDraft: AiScorecardDraft,
  competencyEvidence: z.array(CompetencyEvidence),
  /** Per-transcript flags (leading/illegal questions). Panel divergence is API-computed. */
  calibrationFlags: z.array(CalibrationFlag),
  modelVersion: z.string(),
  promptVersion: z.string().nullable(),
});
export type AnalyzeInterviewResponse = z.infer<typeof AnalyzeInterviewResponse>;

export const TranscribeRequest = z.object({
  orgId: OrgId,
  interviewId: InterviewId,
  audioUrl: z.string().url(),
  language: z.string().nullable().optional(),
  source: TranscriptSource,
});
export type TranscribeRequest = z.infer<typeof TranscribeRequest>;

export const TranscribeResponse = z.object({
  transcript: InterviewTranscript,
  modelVersion: z.string(),
});
export type TranscribeResponse = z.infer<typeof TranscribeResponse>;

// ═══ API-facing ══════════════════════════════════════════════════════════════
export const CreateInterviewRequest = z.object({
  applicationId: ApplicationId,
  interviewerIds: z.array(UserId).default([]),
  scheduledAt: IsoDateTime.nullable().optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
  type: z.enum(["PHONE", "VIDEO", "ONSITE", "TECHNICAL"]).default("VIDEO"),
  /** Candidate consent to record + process is REQUIRED before any transcript work. */
  consentObtained: z.literal(true),
});
export type CreateInterviewRequest = z.infer<typeof CreateInterviewRequest>;

export const SubmitTranscriptRequest = z.object({
  transcript: InterviewTranscript,
});
export type SubmitTranscriptRequest = z.infer<typeof SubmitTranscriptRequest>;

/** Reviewer's final (human) scorecard submission. */
export const SubmitScorecardRequest = z.object({
  competencyScores: z
    .array(
      z.object({
        competencyId: z.string(),
        score: z.number().int().min(1).max(5),
        evidence: z.string().nullable().optional(),
      }),
    )
    .default([]),
  overallRecommendation: ScorecardRecommendation,
});
export type SubmitScorecardRequest = z.infer<typeof SubmitScorecardRequest>;

// ── Panel calibration (API-computed numeric divergence + stored AI flags) ─────
export const CompetencyDivergence = z.object({
  competencyId: z.string(),
  minScore: z.number().int(),
  maxScore: z.number().int(),
  spread: z.number().int(),
  /** Reviewer scores keyed by reviewerId, for drill-down. */
  reviewerScores: z.array(z.object({ reviewerId: UserId.nullable(), score: z.number().int() })),
});
export type CompetencyDivergence = z.infer<typeof CompetencyDivergence>;

export const PanelCalibration = z.object({
  applicationId: ApplicationId,
  reviewerCount: z.number().int().nonnegative(),
  /** Competencies where panel scores diverge by > 2 points (spec). */
  divergences: z.array(CompetencyDivergence),
  /** Per-interview AI flags (leading/illegal questions) gathered across the panel. */
  aiFlags: z.array(CalibrationFlag),
});
export type PanelCalibration = z.infer<typeof PanelCalibration>;

export const InterviewType = z.enum(["PHONE", "VIDEO", "ONSITE", "TECHNICAL"]);
export type InterviewType = z.infer<typeof InterviewType>;

export const InterviewStatus = z.enum(["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
export type InterviewStatus = z.infer<typeof InterviewStatus>;

/**
 * Privacy-safe Interview governance view returned by the interview lifecycle routes
 * (create / submit-transcript / transcribe / DSAR-delete). It NEVER includes the
 * transcript itself — only governance metadata + a `hasTranscript` flag.
 */
export const InterviewSummary = z.object({
  id: InterviewId,
  orgId: OrgId,
  applicationId: ApplicationId,
  interviewerIds: z.array(UserId),
  scheduledAt: IsoDateTime.nullable(),
  durationMinutes: z.number().int().nullable(),
  type: InterviewType,
  status: InterviewStatus,
  consentObtained: z.boolean(),
  transcriptStatus: z.string().nullable(),
  transcriptRetentionDeleteAt: IsoDateTime.nullable(),
  transcriptDeletedAt: IsoDateTime.nullable(),
  hasTranscript: z.boolean(),
  createdAt: IsoDateTime,
});
export type InterviewSummary = z.infer<typeof InterviewSummary>;

/** The persisted interview scorecard as returned to the reviewer UI. */
export const InterviewScorecard = z.object({
  id: ScorecardId,
  interviewId: InterviewId.nullable(),
  applicationId: ApplicationId,
  reviewerId: UserId.nullable(),
  competencyScores: z.array(
    z.object({ competencyId: z.string(), score: z.number().int(), evidence: z.string().nullable() }),
  ),
  overall: ScorecardRecommendation.nullable(),
  aiSummary: z.string().nullable(),
  aiScorecardDraft: AiScorecardDraft.nullable(),
  calibrationFlags: z.array(CalibrationFlag).default([]),
  submittedAt: IsoDateTime.nullable(),
});
export type InterviewScorecard = z.infer<typeof InterviewScorecard>;
