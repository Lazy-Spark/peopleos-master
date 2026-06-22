import { describe, expect, it } from "vitest";
import {
  CandidateProfile,
  CandidateRanking,
  RankingWeights,
  ScoreCandidateRequest,
  ParseResumeRequest,
} from "../src/index.js";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "00000000-0000-0000-0000-0000000000b1";
const CAND = "00000000-0000-0000-0000-0000000000c1";

describe("CandidateProfile", () => {
  it("accepts a minimal profile and applies array defaults", () => {
    const parsed = CandidateProfile.parse({
      name: "Jordan",
      email: "jordan@example.test",
      phone: null,
      linkedinUrl: null,
      githubUrl: null,
      location: null,
      totalYoe: null,
    });
    expect(parsed.skills).toEqual([]);
    expect(parsed.education).toEqual([]);
  });

  it("rejects a non-email email", () => {
    expect(() => CandidateProfile.parse({ email: "not-an-email" })).toThrow();
  });
});

describe("RankingWeights", () => {
  it("defaults sum to 1.0", () => {
    const w = RankingWeights.parse({});
    expect(w.skillMatch + w.expRelevance + w.holistic + w.yoeMatch).toBeCloseTo(1, 5);
  });

  it("rejects weights that do not sum to 1", () => {
    expect(() =>
      RankingWeights.parse({ skillMatch: 0.5, expRelevance: 0.5, holistic: 0.5, yoeMatch: 0.5 }),
    ).toThrow();
  });
});

describe("ScoreCandidateRequest", () => {
  it("round-trips a valid request", () => {
    const req = ScoreCandidateRequest.parse({
      orgId: ORG,
      jobId: JOB,
      candidateId: CAND,
      profile: { totalYoe: 6 },
      jdText: "Senior ML Engineer",
      jdStructured: null,
    });
    expect(req.profile.skills).toEqual([]);
  });
});

describe("ParseResumeRequest", () => {
  it("requires exactly one of fileUrl / rawText", () => {
    expect(() => ParseResumeRequest.parse({ orgId: ORG, candidateId: CAND })).toThrow();
    expect(() =>
      ParseResumeRequest.parse({ orgId: ORG, candidateId: CAND, rawText: "cv", fileUrl: "https://x/y.pdf" }),
    ).toThrow();
    expect(ParseResumeRequest.parse({ orgId: ORG, candidateId: CAND, rawText: "cv" })).toBeTruthy();
  });
});

describe("CandidateRanking", () => {
  it("enforces tier enum and [0,1] final score", () => {
    const base = {
      candidateId: CAND,
      jobId: JOB,
      finalScore: 0.82,
      tier: "A" as const,
      skillMatchPct: 75,
      expRelevanceScore: 0.7,
      components: { skillMatch: 0.8, expRelevance: 0.7, holisticScore: 0.9, yoeMatch: 1 },
      strengths: ["strong python"],
      concerns: [],
      interviewFocus: ["system design"],
      aiSummary: "Strong match.",
      biasCheck: { biasIndicatorsDetected: [], correctionApplied: false },
      confidence: "high" as const,
      scoredAt: new Date().toISOString(),
      modelVersion: "claude-sonnet-4-6",
      promptVersion: "module1.holistic_assessment@1.0.0",
    };
    expect(CandidateRanking.parse(base).tier).toBe("A");
    expect(() => CandidateRanking.parse({ ...base, finalScore: 1.4 })).toThrow();
    expect(() => CandidateRanking.parse({ ...base, tier: "Z" })).toThrow();
  });
});
