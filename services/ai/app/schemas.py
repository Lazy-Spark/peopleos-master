"""Pydantic v2 models MIRRORING ``@peopleos/schemas`` EXACTLY.

The wire contract is camelCase end-to-end (see packages/schemas/src/*.ts). These
models use camelCase attribute names so the emitted JSON matches the TypeScript
contract byte-for-byte on field names. ``populate_by_name`` is enabled so callers
may also construct via the same names; ``model_dump(by_alias=False)`` already emits
camelCase because the attribute names ARE camelCase.

Cross-references (TS source -> this file):
    common.ts      enums + scalars (UnitScore, Percent, RankingTier, Confidence, ...)
    candidate.ts   Education, WorkExperience, CandidateSkill, Certification,
                   LanguageProficiency, ExperienceGap, CandidateProfile
    job.ts         RequiredSkill, JDStructured
    ranking.ts     BiasCheck, HolisticAssessment, RankingComponents, CandidateRanking
    ai.ts          RankingWeights, ScoreCandidateRequest, OrgContext, ParseResume*,
                   ParseJobDescription*, AiHealth

Note on strictness: these models intentionally treat nullable contract fields as
OPTIONAL (absent == null) for ergonomic internal construction. The API always sends
every key (it Zod-parses first) and responses always emit every key, so the strict
contract boundary is the API's Zod layer; this service is deliberately the more
lenient of the two ends. Email/URL/date *formats* are validated on the Zod side.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# ── Shared scalars (common.ts) ────────────────────────────────────────────────
# UnitScore: number in [0,1]. Percent: number in [0,100].
UnitScore = Annotated[float, Field(ge=0.0, le=1.0)]
Percent = Annotated[float, Field(ge=0.0, le=100.0)]

# Enums (string literals match the Zod z.enum values exactly).
SkillCategory = Literal["TECHNICAL", "DOMAIN", "SOFT", "LANGUAGE", "CERTIFICATION"]
ProficiencyLevel = Literal["AWARE", "PRACTITIONER", "ADVANCED", "EXPERT"]
RankingTier = Literal["A", "B", "C", "D"]
Confidence = Literal["low", "medium", "high"]
RoleLevel = Literal[
    "INTERN",
    "JUNIOR",
    "MID",
    "SENIOR",
    "STAFF",
    "PRINCIPAL",
    "MANAGER",
    "DIRECTOR",
    "VP",
    "EXEC",
]
SkillImportance = Literal["CRITICAL", "PREFERRED"]
GapType = Literal["GAP", "OVERLAP"]
UserRole = Literal["ADMIN", "RECRUITER", "HRBP", "MANAGER", "EMPLOYEE"]


class _Base(BaseModel):
    """Base config shared by all wire models."""

    model_config = ConfigDict(
        populate_by_name=True,
        # We do NOT use aliases: attribute names are already the camelCase wire
        # names, so model_dump() emits the contract directly.
        extra="ignore",
        str_strip_whitespace=False,
    )


# ── candidate.ts ──────────────────────────────────────────────────────────────
class Education(_Base):
    school: str
    degree: str | None = None
    field: str | None = None
    startYear: int | None = None
    endYear: int | None = None


class WorkExperience(_Base):
    company: str
    title: str
    startDate: str | None = None  # IsoDate (YYYY-MM-DD) | null
    endDate: str | None = None  # null = current
    description: str | None = None
    isCurrent: bool = False


class CandidateSkill(_Base):
    canonicalName: str
    rawName: str | None = None
    category: SkillCategory
    proficiency: ProficiencyLevel | None = None
    confidence: UnitScore = 0.6


class Certification(_Base):
    name: str
    issuer: str | None = None
    year: int | None = None


class LanguageProficiency(_Base):
    language: str
    level: str | None = None


class ExperienceGap(_Base):
    type: GapType
    fromDate: str  # IsoDate
    toDate: str  # IsoDate
    months: Annotated[float, Field(ge=0.0)]


class CandidateProfile(_Base):
    name: str | None = None
    # Plain string: the Zod contract validates email shape (z.string().email()), and
    # the resume pipeline regex-checks before setting it. Avoids the email-validator
    # dependency that EmailStr requires at model-build time.
    email: str | None = None
    phone: str | None = None
    linkedinUrl: str | None = None
    githubUrl: str | None = None
    location: str | None = None
    education: list[Education] = Field(default_factory=list)
    experience: list[WorkExperience] = Field(default_factory=list)
    skills: list[CandidateSkill] = Field(default_factory=list)
    certifications: list[Certification] = Field(default_factory=list)
    languages: list[LanguageProficiency] = Field(default_factory=list)
    publications: list[str] = Field(default_factory=list)
    gaps: list[ExperienceGap] = Field(default_factory=list)
    totalYoe: Annotated[float, Field(ge=0.0)] | None = None


# ── job.ts ────────────────────────────────────────────────────────────────────
class RequiredSkill(_Base):
    canonicalName: str
    importance: SkillImportance


class JDStructured(_Base):
    requiredSkills: list[RequiredSkill] = Field(default_factory=list)
    preferredSkills: list[str] = Field(default_factory=list)
    requiredYoe: Annotated[float, Field(ge=0.0)] | None = None
    niceToHaveYoe: Annotated[float, Field(ge=0.0)] | None = None
    roleLevel: RoleLevel | None = None
    keyResponsibilities: list[str] = Field(default_factory=list)
    teamContext: str | None = None
    reportingStructure: str | None = None


# ── ranking.ts ────────────────────────────────────────────────────────────────
class BiasCheck(_Base):
    biasIndicatorsDetected: list[str] = Field(default_factory=list)
    correctionApplied: bool = False


class HolisticAssessment(_Base):
    """LLM structured output from Module 1 step 4 (model sees a bias-masked profile)."""

    holisticScore: UnitScore
    strengths: list[str]
    concerns: list[str]
    suggestedInterviewFocus: list[str]
    calibrationNote: str
    confidence: Confidence
    biasCheck: BiasCheck


class RankingComponents(_Base):
    skillMatch: UnitScore  # weight 0.35
    expRelevance: UnitScore  # weight 0.30
    holisticScore: UnitScore  # weight 0.25
    yoeMatch: UnitScore  # weight 0.10


class CandidateRanking(_Base):
    """Persisted / API-returned ranking record (Module 1 output)."""

    candidateId: str
    jobId: str
    finalScore: UnitScore
    tier: RankingTier
    skillMatchPct: Percent
    expRelevanceScore: UnitScore
    components: RankingComponents
    strengths: list[str]
    concerns: list[str]
    interviewFocus: list[str]
    aiSummary: str
    biasCheck: BiasCheck
    confidence: Confidence
    scoredAt: str  # IsoDateTime
    modelVersion: str
    promptVersion: str | None = None


# ── ai.ts ─────────────────────────────────────────────────────────────────────
class RankingWeights(_Base):
    """Per-org configurable weights (must sum to ~1.0)."""

    skillMatch: UnitScore = 0.35
    expRelevance: UnitScore = 0.30
    holistic: UnitScore = 0.25
    yoeMatch: UnitScore = 0.10

    @model_validator(mode="after")
    def _weights_sum_to_one(self) -> RankingWeights:
        total = self.skillMatch + self.expRelevance + self.holistic + self.yoeMatch
        if abs(total - 1.0) >= 0.001:
            raise ValueError("Ranking weights must sum to 1.0")
        return self


MimeType = Literal[
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
]


class ParseResumeRequest(_Base):
    orgId: str
    candidateId: str
    fileUrl: str | None = None  # S3/MinIO presigned URL
    rawText: str | None = None
    mimeType: MimeType | None = None

    @model_validator(mode="after")
    def _exactly_one_source(self) -> ParseResumeRequest:
        # Mirrors the Zod .refine: exactly one of fileUrl / rawText.
        if bool(self.fileUrl) == bool(self.rawText):
            raise ValueError("Provide exactly one of fileUrl or rawText")
        return self


class ParseResumeResponse(_Base):
    profile: CandidateProfile
    warnings: list[str] = Field(default_factory=list)
    modelVersion: str
    parsedAt: str  # IsoDateTime


class ParseJobDescriptionRequest(_Base):
    orgId: str
    jobId: str
    jdText: Annotated[str, Field(min_length=1)]


class ParseJobDescriptionResponse(_Base):
    jdStructured: JDStructured
    modelVersion: str


class OrgContext(_Base):
    """Optional per-org context for prompt personalisation (prompt standard #1).

    Mirrors @peopleos/schemas OrgContext. All fields optional/nullable; when absent
    the prompts fall back to generic framing.
    """

    orgName: str | None = None
    industry: str | None = None
    headcount: int | None = None
    userRole: UserRole | None = None
    tonePreferences: str | None = None
    customRules: list[str] = Field(default_factory=list)


class ScoreCandidateRequest(_Base):
    orgId: str
    jobId: str
    candidateId: str
    profile: CandidateProfile
    jdText: str | None = None
    jdStructured: JDStructured | None = None
    weights: RankingWeights | None = None
    orgContext: OrgContext | None = None


# ScoreCandidateResponse === CandidateRanking (ai.ts line 78).
ScoreCandidateResponse = CandidateRanking


class AiHealth(_Base):
    status: Literal["ok"]
    model: str
    version: str


# ── Batch ranking (ai.ts) ─────────────────────────────────────────────────────
class BatchCandidateInput(_Base):
    candidateId: str
    profile: CandidateProfile


class ScoreBatchRequest(_Base):
    orgId: str
    jobId: str
    jdText: str | None = None
    jdStructured: JDStructured | None = None
    weights: RankingWeights | None = None
    orgContext: OrgContext | None = None
    candidates: list[BatchCandidateInput] = Field(min_length=1, max_length=200)


class ScoreBatchResponse(_Base):
    rankings: list[CandidateRanking]


# ── Disparity audit (audit.ts) ────────────────────────────────────────────────
class DisparityRecord(_Base):
    group: Annotated[str, Field(min_length=1)]
    score: UnitScore
    tier: RankingTier


class DisparityRequest(_Base):
    records: list[DisparityRecord] = Field(min_length=1)
    selectionTiers: list[RankingTier] = Field(default_factory=lambda: ["A", "B"])


class GroupStat(_Base):
    group: str
    n: Annotated[int, Field(ge=0)]
    selected: Annotated[int, Field(ge=0)]
    selectionRate: UnitScore
    meanScore: UnitScore


class DisparityReport(_Base):
    groups: list[GroupStat]
    referenceGroup: str | None = None
    adverseImpactRatio: float | None = None
    fourFifthsViolation: bool
    disproportionateFlag: bool
    generatedAt: str  # IsoDateTime


# ═══ Module 2 — Recruiter Copilot (copilot.ts) ════════════════════════════════
# ── 2a JD Writer ──
InclusiveCategory = Literal["GENDERED", "EXCLUSIONARY", "AGE", "JARGON", "ABLEIST", "OTHER"]


class InclusiveFlag(_Base):
    phrase: str
    category: InclusiveCategory
    suggestion: str


class InclusiveLanguageReport(_Base):
    flagged: list[InclusiveFlag] = Field(default_factory=list)
    biasCheck: BiasCheck


class WriteJobDescriptionRequest(_Base):
    orgId: str
    roleTitle: Annotated[str, Field(min_length=1)]
    seniority: RoleLevel | None = None
    department: str | None = None
    teamContext: str | None = None
    hiringManagerNotes: str | None = None
    orgContext: OrgContext | None = None
    priorJdExamples: list[str] = Field(default_factory=list)


class GeneratedJobDescription(_Base):
    title: str
    summary: str
    responsibilities: list[str]
    requirements: list[str]
    preferred: list[str]
    benefits: list[str]
    deiStatement: str
    jdText: str
    inclusiveLanguage: InclusiveLanguageReport
    modelVersion: str
    promptVersion: str | None = None


# ── 2b Outreach ──
OutreachTone = Literal["WARM", "FORMAL", "BRIEF"]


class OutreachVariant(_Base):
    tone: OutreachTone
    subject: str
    body: str


class GenerateOutreachRequest(_Base):
    orgId: str
    jobId: str
    candidateId: str
    profile: CandidateProfile
    jobTitle: str
    jobSummary: str | None = None
    recruiterName: str
    orgContext: OrgContext | None = None
    tones: list[OutreachTone] = Field(default_factory=lambda: ["WARM", "FORMAL", "BRIEF"])


class OutreachInMail(_Base):
    subject: str | None = None
    body: str


class OutreachResult(_Base):
    variants: list[OutreachVariant]
    inMail: OutreachInMail
    subjectVariants: list[str]
    biasCheck: BiasCheck
    modelVersion: str
    promptVersion: str | None = None


# ── 2c Chat ReAct + internal tools ──
ChatRole = Literal["user", "assistant"]


class ChatTurn(_Base):
    role: ChatRole
    content: str


class ChatToolInvocation(_Base):
    tool: str
    ok: bool
    resultSummary: str | None = None


class RecruiterChatRequest(_Base):
    orgId: str
    userRole: UserRole | None = None
    messages: list[ChatTurn] = Field(min_length=1)
    jobId: str | None = None


class RecruiterChatResponse(_Base):
    answer: str
    toolTrace: list[ChatToolInvocation] = Field(default_factory=list)
    modelVersion: str


class ToolSearchCandidatesRequest(_Base):
    orgId: str
    query: str
    jobId: str | None = None
    limit: Annotated[int, Field(ge=1, le=25)] = 10


class ToolCandidateHit(_Base):
    candidateId: str
    name: str | None = None
    headline: str | None = None
    topSkills: list[str] = Field(default_factory=list)


class ToolSearchCandidatesResponse(_Base):
    candidates: list[ToolCandidateHit]


class ToolPipelineStatsRequest(_Base):
    orgId: str
    jobId: str


class ToolPipelineStats(_Base):
    jobId: str
    total: Annotated[int, Field(ge=0)]
    byStage: dict[str, int]
    conversionRates: dict[str, float]
    daysOpen: int | None = None


class ToolCandidateRequest(_Base):
    orgId: str
    candidateId: str


class ToolCandidateResponse(_Base):
    candidateId: str
    name: str | None = None
    profile: CandidateProfile | None = None
    latestTier: RankingTier | None = None


# ── 2d LinkedIn ──
class LinkedInExperience(_Base):
    company: str | None = None
    title: str | None = None
    dateRange: str | None = None
    description: str | None = None


class LinkedInEducation(_Base):
    school: str | None = None
    degree: str | None = None
    field: str | None = None


class LinkedInScrapedProfile(_Base):
    url: str
    name: str | None = None
    headline: str | None = None
    location: str | None = None
    about: str | None = None
    experience: list[LinkedInExperience] = Field(default_factory=list)
    education: list[LinkedInEducation] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)


class LinkedInMatchRole(_Base):
    jobId: str
    title: str
    jdText: str | None = None
    jdStructured: JDStructured | None = None


class AnalyzeLinkedInRequest(_Base):
    orgId: str
    profile: LinkedInScrapedProfile
    consent: Literal[True]
    roles: list[LinkedInMatchRole] = Field(default_factory=list)


class LinkedInRoleMatch(_Base):
    jobId: str
    title: str
    matchScore: UnitScore
    tier: RankingTier
    skillMatchPct: Percent
    topGaps: list[str] = Field(default_factory=list)


class AnalyzeLinkedInResponse(_Base):
    summary: str
    candidateProfile: CandidateProfile
    roleMatches: list[LinkedInRoleMatch]
    biasCheck: BiasCheck
    modelVersion: str


# ═══ Module 3 — Interview Intelligence (interview.ts) ═════════════════════════
SpeakerRole = Literal["INTERVIEWER", "CANDIDATE", "UNKNOWN"]
TranscriptSource = Literal["ZOOM", "GOOGLE_MEET", "MS_TEAMS", "UPLOAD"]
ScorecardRecommendation = Literal["STRONG_YES", "YES", "NO", "STRONG_NO"]
FlagSeverity = Literal["LOW", "MEDIUM", "HIGH"]
IllegalTopic = Literal[
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
]
CalibrationFlagType = Literal["LEADING_QUESTION", "ILLEGAL_QUESTION", "SCORE_DIVERGENCE"]


class TranscriptSegment(_Base):
    speakerLabel: str
    speakerRole: SpeakerRole
    startSec: Annotated[float, Field(ge=0.0)]
    endSec: Annotated[float, Field(ge=0.0)]
    text: str


class InterviewTranscript(_Base):
    segments: list[TranscriptSegment]
    durationSec: float | None = None
    language: str | None = None
    source: TranscriptSource
    diarised: bool = False


class StarScores(_Base):
    situation: UnitScore
    task: UnitScore
    action: UnitScore
    result: UnitScore


class CompetencyEvidence(_Base):
    question: str
    answerSummary: str
    behaviouralIndicators: list[str] = Field(default_factory=list)
    competencyArea: str
    star: StarScores
    starCompleteness: UnitScore


class ScorecardCompetency(_Base):
    competencyId: str
    name: str
    description: str | None = None


class ScorecardTemplate(_Base):
    competencies: list[ScorecardCompetency] = Field(default_factory=list)


class CompetencyScore(_Base):
    competencyId: str
    competencyName: str
    score: Annotated[int, Field(ge=1, le=5)]
    evidenceQuote: str
    rationale: str


class AiScorecardDraft(_Base):
    competencyScores: list[CompetencyScore]
    overallRecommendation: ScorecardRecommendation
    confidence: Confidence
    keyReasons: list[str]
    summary: str
    biasCheck: BiasCheck


class CalibrationFlag(_Base):
    type: CalibrationFlagType
    severity: FlagSeverity
    detail: str
    evidenceQuote: str | None = None
    illegalTopic: IllegalTopic | None = None
    competencyId: str | None = None


class AnalyzeInterviewRequest(_Base):
    orgId: str
    interviewId: str
    jobTitle: str | None = None
    scorecardTemplate: ScorecardTemplate
    transcript: InterviewTranscript
    orgContext: OrgContext | None = None


class AnalyzeInterviewResponse(_Base):
    scorecardDraft: AiScorecardDraft
    competencyEvidence: list[CompetencyEvidence]
    calibrationFlags: list[CalibrationFlag]
    modelVersion: str
    promptVersion: str | None = None


class TranscribeRequest(_Base):
    orgId: str
    interviewId: str
    audioUrl: str
    language: str | None = None
    source: TranscriptSource


class TranscribeResponse(_Base):
    transcript: InterviewTranscript
    modelVersion: str


# ═══ Module 4 — Knowledge base + HR chatbot RAG (knowledge.ts) ════════════════
PolicyDocType = Literal[
    "HANDBOOK", "BENEFITS", "PTO", "CONDUCT", "SECURITY", "COMPENSATION", "CAREER_LADDER", "OTHER"
]
ChatIntent = Literal["POLICY_QUESTION", "ACTION_REQUEST", "ESCALATE"]


class DocumentChunkData(_Base):
    sectionPath: str
    text: str
    charStart: Annotated[int, Field(ge=0)]
    charEnd: Annotated[int, Field(ge=0)]
    pageNumber: int | None = None
    tokenCount: Annotated[int, Field(ge=0)]
    embedding: list[float]


class PolicyIngestRequest(_Base):
    orgId: str
    docId: str
    docType: PolicyDocType
    title: str
    rawText: str


class PolicyIngestResponse(_Base):
    chunks: list[DocumentChunkData]
    simhash: str
    modelVersion: str


class EmbedRequest(_Base):
    texts: list[str] = Field(min_length=1, max_length=128)


class EmbedResponse(_Base):
    embeddings: list[list[float]]
    model: str
    dim: Annotated[int, Field(gt=0)]


class Citation(_Base):
    docId: str
    docTitle: str
    sectionPath: str
    effectiveDate: str | None = None


class RetrievedChunk(_Base):
    docId: str
    docTitle: str
    sectionPath: str
    text: str
    effectiveDate: str | None = None
    score: UnitScore


class EmployeeChatContext(_Base):
    department: str | None = None
    location: str | None = None
    hireDate: str | None = None


class ChatAnswerRequest(_Base):
    orgId: str
    query: Annotated[str, Field(min_length=1)]
    history: list[ChatTurn] = Field(default_factory=list)
    candidateChunks: list[RetrievedChunk] = Field(default_factory=list)
    employeeContext: EmployeeChatContext | None = None
    orgContext: OrgContext | None = None


class ChatAnswerResponse(_Base):
    answer: str
    citations: list[Citation]
    intent: ChatIntent
    escalate: bool
    escalationReason: str | None = None
    sensitiveTopic: str | None = None
    confidence: Confidence
    topic: str | None = None
    biasCheck: BiasCheck
    modelVersion: str
    promptVersion: str | None = None


# ═══ Module 5 — Workforce analytics (analytics.ts) ════════════════════════════
# The AI narrates/answers over the metrics generically, so `metrics` is accepted as an
# opaque dict here (the API already validated it against the strict Zod DashboardMetrics).
ChartType = Literal["BAR", "LINE", "PIE"]


class NarrativeMetric(_Base):
    label: str
    value: str
    note: str | None = None


class Anomaly(_Base):
    metric: str
    detail: str
    severity: FlagSeverity


class ChartPoint(_Base):
    label: str
    value: float


class ChartSpec(_Base):
    type: ChartType
    title: str
    series: list[ChartPoint]


class AnalyticsNarrativeRequest(_Base):
    orgId: str
    metrics: dict[str, object]
    orgContext: OrgContext | None = None


class AnalyticsNarrativeResponse(_Base):
    headline: str
    narrative: str
    keyMetrics: list[NarrativeMetric]
    anomalies: list[Anomaly]
    modelVersion: str
    promptVersion: str | None = None


class AskDataRequest(_Base):
    orgId: str
    question: Annotated[str, Field(min_length=1)]
    metrics: dict[str, object]
    orgContext: OrgContext | None = None


class AskDataResponse(_Base):
    answer: str
    usedMetrics: list[str]
    chart: ChartSpec | None = None
    confidence: Confidence
    modelVersion: str


# ═══ Module 6 — Skill graph AI (skills.ts) ════════════════════════════════════
class EmployeeSkillBrief(_Base):
    name: str
    proficiency: ProficiencyLevel


class GrowthPathRequest(_Base):
    orgId: str
    employeeSkills: list[EmployeeSkillBrief]
    targetRoleTitle: str
    targetRequiredSkills: list[str]
    skillCatalog: list[str] = Field(default_factory=list)
    orgContext: OrgContext | None = None


class RecommendedSkill(_Base):
    skill: str
    why: str
    suggestedTraining: str | None = None


class GrowthPathResponse(_Base):
    summary: str
    stepsAway: Annotated[int, Field(ge=0)]
    recommendedSkills: list[RecommendedSkill]
    confidence: Confidence
    biasCheck: BiasCheck
    modelVersion: str
    promptVersion: str | None = None


BuildVsBuyRecommendation = Literal["BUILD", "BUY", "HYBRID"]


class BuildVsBuyRequest(_Base):
    orgId: str
    skill: str
    currentSupply: Annotated[int, Field(ge=0)]
    demand: Annotated[int, Field(ge=0)]
    trainableInternally: Annotated[int, Field(ge=0)]
    orgContext: OrgContext | None = None


class BuildVsBuyResponse(_Base):
    recommendation: BuildVsBuyRecommendation
    rationale: str
    modelVersion: str
    promptVersion: str | None = None


# ═══ Module 7 — Attrition prediction (attrition.ts) ═══════════════════════════
RiskTier = Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]
DriverDirection = Literal["INCREASES", "DECREASES"]


class AttritionFeatures(_Base):
    tenureDays: Annotated[float, Field(ge=0.0)]
    timeInRoleDays: float | None = None
    daysSinceLastPromotion: float | None = None
    daysSinceLastReview: float | None = None
    perfRating: float | None = None
    teamAttritionRate90d: UnitScore
    managerChanged90d: bool
    skillAdditions90d: Annotated[int, Field(ge=0)]


class DriverContribution(_Base):
    feature: str
    label: str
    contribution: float
    direction: DriverDirection


class EmployeeFeatures(_Base):
    employeeId: str
    features: AttritionFeatures


class ScoreAttritionRequest(_Base):
    orgId: str
    employees: list[EmployeeFeatures] = Field(min_length=1, max_length=2000)


class ScoredEmployee(_Base):
    employeeId: str
    riskScore: UnitScore
    riskTier: RiskTier
    topDrivers: list[DriverContribution]
    shapValues: dict[str, float]


class ScoreAttritionResponse(_Base):
    scores: list[ScoredEmployee]
    modelVersion: str


class AttritionEmployeeContext(_Base):
    tenureDays: Annotated[float, Field(ge=0.0)]
    roleTitle: str | None = None
    department: str | None = None
    level: RoleLevel | None = None


class ExplainAttritionRequest(_Base):
    orgId: str
    riskTier: RiskTier
    topDrivers: list[DriverContribution]
    employeeContext: AttritionEmployeeContext
    orgContext: OrgContext | None = None


class ExplainAttritionResponse(_Base):
    narrative: str
    recommendedActions: list[str]
    confidence: Confidence
    biasCheck: BiasCheck
    modelVersion: str
    promptVersion: str | None = None


# ═══ Module 8 — Internal mobility (mobility.ts) ═══════════════════════════════
Readiness = Literal["READY_NOW", "READY_SOON", "STRETCH"]


class MobilityEmployeeContext(_Base):
    roleTitle: str | None = None
    level: RoleLevel | None = None
    department: str | None = None


class MobilityRecommendRequest(_Base):
    orgId: str
    targetRoleTitle: str
    requiredSkills: list[str]
    matchedSkills: list[str]
    missingSkills: list[str]
    readiness: Readiness
    employeeContext: MobilityEmployeeContext | None = None
    orgContext: OrgContext | None = None


class DevelopmentStep(_Base):
    skill: str
    action: str
    suggestedResource: str | None = None


class MobilityRecommendResponse(_Base):
    fitSummary: str
    developmentPlan: list[DevelopmentStep]
    confidence: Confidence
    biasCheck: BiasCheck
    modelVersion: str
    promptVersion: str | None = None


# ═══ Module 9 — Workflow automation (workflow.ts) ═════════════════════════════
WorkflowTrigger = Literal["MANUAL", "EVENT", "SCHEDULED"]
StepType = Literal["TASK", "APPROVAL", "NOTIFICATION", "AI_TASK", "TIMER", "BRANCH"]
BranchOp = Literal["EQ", "NE", "EXISTS", "GT", "LT"]


class BranchCondition(_Base):
    field: str
    op: BranchOp
    value: str | int | float | bool | None = None


class BranchRule(_Base):
    when: BranchCondition
    next: str


class WorkflowStep(_Base):
    id: str
    type: StepType
    name: str
    assigneeRole: str | None = None
    slaHours: int | None = None
    config: dict[str, object] | None = None
    next: str | None = None
    branches: list[BranchRule] | None = None


class DraftWorkflowRequest(_Base):
    orgId: str
    description: str
    orgContext: OrgContext | None = None


class DraftWorkflowResponse(_Base):
    name: str
    trigger: WorkflowTrigger
    eventType: str | None = None
    steps: list[WorkflowStep]
    confidence: Confidence
    modelVersion: str
    promptVersion: str | None = None


# ═══ Module 10 — Agentic HR Assistant (assistant.ts) ══════════════════════════
class ToolCallTrace(_Base):
    tool: str
    ok: bool
    summary: str


class AssistantContext(_Base):
    orgId: str
    userId: str
    role: UserRole


class AssistantHistoryMessage(_Base):
    role: Literal["user", "assistant"]
    content: str


class AssistantChatAiRequest(_Base):
    message: str
    history: list[AssistantHistoryMessage]
    context: AssistantContext
    orgContext: OrgContext | None = None


class AssistantChatAiResponse(_Base):
    reply: str
    toolCalls: list[ToolCallTrace]
    suggestedActions: list[str]


class ToolInvokeRequest(_Base):
    tool: str
    args: dict[str, object]
    context: AssistantContext


class ToolInvokeResponse(_Base):
    ok: bool
    data: object | None = None
    summary: str
    error: str | None = None
