"""Unit tests for Module 1 — skill match, bias masking, and the offline ranker.

All tests run WITHOUT network: the ranker's deterministic fallbacks cover the
LLM/embedding steps, and validation is exercised with an injected fake llm_call.
"""

from __future__ import annotations

import pytest
from app.bias import mask_profile
from app.evals.run_evals import run_evals
from app.modules.resume_ranker import _tier, score_batch, score_candidate
from app.schemas import (
    BatchCandidateInput,
    CandidateProfile,
    CandidateSkill,
    Education,
    HolisticAssessment,
    JDStructured,
    RequiredSkill,
    ScoreBatchRequest,
    ScoreCandidateRequest,
    WorkExperience,
)
from app.scoring.skill_match import score_skill_match
from app.scoring.yoe import score_yoe_match
from app.validation import HumanReviewNeeded, validate_or_review

_ORG = "00000000-0000-0000-0000-000000000001"
_JOB = "00000000-0000-0000-0000-000000000002"
_CAND = "00000000-0000-0000-0000-000000000003"


def _skill(name: str, raw: str | None = None) -> CandidateSkill:
    return CandidateSkill(canonicalName=name, rawName=raw, category="TECHNICAL", confidence=0.6)


# ── skill_match ────────────────────────────────────────────────────────────────
def test_skill_match_full_coverage() -> None:
    profile = CandidateProfile(skills=[_skill("Go"), _skill("Kafka")])
    jd = JDStructured(
        requiredSkills=[
            RequiredSkill(canonicalName="Go", importance="CRITICAL"),
            RequiredSkill(canonicalName="Kafka", importance="CRITICAL"),
        ]
    )
    result = score_skill_match(profile, jd)
    assert result.skill_match == pytest.approx(1.0)
    assert result.skill_match_pct == pytest.approx(100.0)
    assert set(result.matched) == {"Go", "Kafka"}
    assert result.missing == []


def test_skill_match_critical_weighted_double() -> None:
    # One CRITICAL (weight 2) matched, one PREFERRED (weight 1) missing => 2/3.
    profile = CandidateProfile(skills=[_skill("Go")])
    jd = JDStructured(
        requiredSkills=[
            RequiredSkill(canonicalName="Go", importance="CRITICAL"),
            RequiredSkill(canonicalName="Rust", importance="PREFERRED"),
        ]
    )
    result = score_skill_match(profile, jd)
    assert result.skill_match == pytest.approx(2.0 / 3.0, abs=1e-6)
    assert result.missing == ["Rust"]


def test_skill_match_synonym_alias() -> None:
    # "React.js" on the profile must match a "React" requirement via the alias table.
    profile = CandidateProfile(skills=[_skill("React", raw="React.js")])
    jd = JDStructured(requiredSkills=[RequiredSkill(canonicalName="React", importance="CRITICAL")])
    result = score_skill_match(profile, jd)
    assert result.skill_match == pytest.approx(1.0)


def test_skill_match_no_requirements_is_neutral_zero() -> None:
    profile = CandidateProfile(skills=[_skill("Go")])
    result = score_skill_match(profile, JDStructured())
    assert result.skill_match == 0.0
    assert result.matched == [] and result.missing == []


# ── yoe ──────────────────────────────────────────────────────────────────────
def test_yoe_meets_requirement() -> None:
    profile = CandidateProfile(totalYoe=6)
    jd = JDStructured(requiredYoe=5)
    assert score_yoe_match(profile, jd) == pytest.approx(1.0)


def test_yoe_below_requirement_is_ratio() -> None:
    profile = CandidateProfile(totalYoe=3)
    jd = JDStructured(requiredYoe=5)
    assert score_yoe_match(profile, jd) == pytest.approx(0.6)


def test_yoe_unknown_is_conservative() -> None:
    profile = CandidateProfile(totalYoe=None)
    jd = JDStructured(requiredYoe=5)
    assert score_yoe_match(profile, jd) == pytest.approx(0.5)


def test_yoe_no_requirement_is_full_credit() -> None:
    profile = CandidateProfile(totalYoe=1)
    assert score_yoe_match(profile, JDStructured(requiredYoe=None)) == pytest.approx(1.0)


# ── bias masking ───────────────────────────────────────────────────────────────
def test_mask_profile_strips_identity_age_and_school() -> None:
    profile = CandidateProfile(
        name="Jane Doe",
        email="jane@example.com",
        phone="+1 555 123 4567",
        linkedinUrl="https://linkedin.com/in/janedoe",
        githubUrl="https://github.com/janedoe",
        location="Berlin, DE",
        education=[
            Education(school="MIT", degree="BSc", field="CS", startYear=2010, endYear=2014)
        ],
        experience=[
            WorkExperience(company="Acme", title="Engineer", startDate="2015-01-01", endDate=None, isCurrent=True)
        ],
        skills=[_skill("Go")],
        totalYoe=8,
    )
    masked = mask_profile(profile)

    # Identity / contact / location removed.
    assert masked.name is None
    assert masked.email is None
    assert masked.phone is None
    assert masked.linkedinUrl is None
    assert masked.githubUrl is None
    assert masked.location is None

    # School redacted; graduation years stripped (age proxy). Degree/field kept.
    assert masked.education[0].school == "[REDACTED SCHOOL]"
    assert masked.education[0].startYear is None
    assert masked.education[0].endYear is None
    assert masked.education[0].degree == "BSc"
    assert masked.education[0].field == "CS"

    # Legitimate evaluation signals retained.
    assert masked.skills[0].canonicalName == "Go"
    assert masked.experience[0].company == "Acme"
    assert masked.totalYoe == 8

    # Original is not mutated.
    assert profile.name == "Jane Doe"
    assert profile.education[0].school == "MIT"


# ── tier thresholds ────────────────────────────────────────────────────────────
def test_tier_thresholds() -> None:
    assert _tier(0.95) == "A"
    assert _tier(0.70) == "B"
    assert _tier(0.50) == "C"
    assert _tier(0.10) == "D"


# ── validate_or_review (retry then human review) ─────────────────────────────
@pytest.mark.asyncio
async def test_validate_or_review_succeeds_first_try() -> None:
    valid = (
        '{"holisticScore":0.8,"strengths":["x"],"concerns":[],'
        '"suggestedInterviewFocus":["y"],"calibrationNote":"ok","confidence":"high",'
        '"biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}'
    )

    async def fake_llm(_prompt: str) -> str:
        return valid

    out = await validate_or_review(
        HolisticAssessment,
        llm_call=fake_llm,
        user_prompt="score it",
        ctx={"orgId": _ORG},
        module="module1",
        task="holistic_assessment",
    )
    assert out.holisticScore == pytest.approx(0.8)
    assert out.confidence == "high"


@pytest.mark.asyncio
async def test_validate_or_review_routes_to_human_after_retries() -> None:
    calls = {"n": 0}

    async def always_bad(_prompt: str) -> str:
        calls["n"] += 1
        return "not json at all"

    with pytest.raises(HumanReviewNeeded) as exc:
        await validate_or_review(
            HolisticAssessment,
            llm_call=always_bad,
            user_prompt="score it",
            ctx={"orgId": _ORG, "candidateId": _CAND},
            module="module1",
            task="holistic_assessment",
            max_retries=2,
        )
    # Initial attempt + 2 retries = 3 calls.
    assert calls["n"] == 3
    assert exc.value.module == "module1"
    assert exc.value.payload["candidateId"] == _CAND
    assert "rawOutput" in exc.value.payload


# ── full offline ranker run ────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_score_candidate_offline_strong_match() -> None:
    profile = CandidateProfile(
        name="Strong Candidate",
        education=[Education(school="Some University", degree="MSc", field="CS", startYear=2012, endYear=2014)],
        experience=[
            WorkExperience(
                company="PayFlow",
                title="Senior Backend Engineer",
                startDate="2018-01-01",
                endDate=None,
                description="Designed payments platform in Go with Kafka event-driven services.",
                isCurrent=True,
            )
        ],
        skills=[_skill("Go", raw="Golang"), _skill("Kafka")],
        totalYoe=9,
    )
    jd = JDStructured(
        requiredSkills=[
            RequiredSkill(canonicalName="Go", importance="CRITICAL"),
            RequiredSkill(canonicalName="Kafka", importance="CRITICAL"),
        ],
        requiredYoe=5,
        roleLevel="SENIOR",
        keyResponsibilities=["Design the payments platform in Go", "Build Kafka services"],
    )
    req = ScoreCandidateRequest(
        orgId=_ORG, jobId=_JOB, candidateId=_CAND, profile=profile, jdText=None, jdStructured=jd
    )
    ranking = await score_candidate(req)

    assert ranking.candidateId == _CAND
    assert ranking.jobId == _JOB
    assert 0.0 <= ranking.finalScore <= 1.0
    assert ranking.tier in {"A", "B", "C", "D"}
    # Strong skill coverage => high skill component and a good tier.
    assert ranking.components.skillMatch == pytest.approx(1.0)
    assert ranking.tier in {"A", "B"}
    # Offline run: model version flags the fallback; prompt version is recorded.
    assert "offline_fallback" in ranking.modelVersion
    assert ranking.promptVersion is not None


@pytest.mark.asyncio
async def test_score_candidate_offline_weak_match_low_tier() -> None:
    profile = CandidateProfile(
        name="Weak Candidate",
        experience=[
            WorkExperience(
                company="AdAgency",
                title="Marketing Coordinator",
                startDate="2019-08-01",
                endDate=None,
                description="Managed social media campaigns.",
                isCurrent=True,
            )
        ],
        skills=[_skill("Google Analytics")],
        totalYoe=5,
    )
    jd = JDStructured(
        requiredSkills=[
            RequiredSkill(canonicalName="Go", importance="CRITICAL"),
            RequiredSkill(canonicalName="Kafka", importance="CRITICAL"),
            RequiredSkill(canonicalName="Kubernetes", importance="CRITICAL"),
        ],
        requiredYoe=5,
        roleLevel="SENIOR",
        keyResponsibilities=["Design distributed Go services"],
    )
    req = ScoreCandidateRequest(
        orgId=_ORG, jobId=_JOB, candidateId=_CAND, profile=profile, jdText=None, jdStructured=jd
    )
    ranking = await score_candidate(req)
    assert ranking.components.skillMatch == pytest.approx(0.0)
    assert ranking.tier in {"C", "D"}


# ── batch scoring (Module 1: parallelised across applicant batch) ───────────────
def _strong_profile() -> CandidateProfile:
    return CandidateProfile(
        name="Strong Candidate",
        experience=[
            WorkExperience(
                company="PayFlow",
                title="Senior Backend Engineer",
                startDate="2018-01-01",
                endDate=None,
                description="Designed payments platform in Go with Kafka event-driven services.",
                isCurrent=True,
            )
        ],
        skills=[_skill("Go", raw="Golang"), _skill("Kafka")],
        totalYoe=9,
    )


def _weak_profile() -> CandidateProfile:
    return CandidateProfile(
        name="Weak Candidate",
        skills=[_skill("Google Analytics")],
        totalYoe=2,
    )


_BACKEND_JD = JDStructured(
    requiredSkills=[
        RequiredSkill(canonicalName="Go", importance="CRITICAL"),
        RequiredSkill(canonicalName="Kafka", importance="CRITICAL"),
    ],
    requiredYoe=5,
    roleLevel="SENIOR",
    keyResponsibilities=["Design the payments platform in Go", "Build Kafka services"],
)


@pytest.mark.asyncio
async def test_score_batch_scores_all_candidates_in_input_order() -> None:
    req = ScoreBatchRequest(
        orgId=_ORG,
        jobId=_JOB,
        jdText=None,
        jdStructured=_BACKEND_JD,
        candidates=[
            BatchCandidateInput(candidateId="00000000-0000-0000-0000-00000000000a", profile=_strong_profile()),
            BatchCandidateInput(candidateId="00000000-0000-0000-0000-00000000000b", profile=_weak_profile()),
        ],
    )
    results = await score_batch(req)

    assert len(results) == 2
    # Each item is (ranking, reasoning); reasoning is the audit-only CoT string.
    rankings = [r for r, _reason in results]
    reasonings = [reason for _r, reason in results]
    # Input order is preserved (the API sorts best-first downstream).
    assert rankings[0].candidateId == "00000000-0000-0000-0000-00000000000a"
    assert rankings[1].candidateId == "00000000-0000-0000-0000-00000000000b"
    # The strong candidate outscores the weak one.
    assert rankings[0].finalScore > rankings[1].finalScore
    # Offline path: a reasoning string is produced for audit (never returned to client).
    assert all(isinstance(reason, str) for reason in reasonings)
    assert all(r.jobId == _JOB for r in rankings)


@pytest.mark.asyncio
async def test_score_batch_one_failure_does_not_sink_the_batch(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from app.modules import resume_ranker as rr

    good_id = "00000000-0000-0000-0000-0000000000c1"
    bad_id = "00000000-0000-0000-0000-0000000000c2"

    real = rr.score_candidate_with_reasoning

    async def flaky(req, *, settings=None):  # type: ignore[no-untyped-def]
        if req.candidateId == bad_id:
            raise RuntimeError("simulated per-candidate failure")
        return await real(req, settings=settings)

    monkeypatch.setattr(rr, "score_candidate_with_reasoning", flaky)

    req = ScoreBatchRequest(
        orgId=_ORG,
        jobId=_JOB,
        jdText=None,
        jdStructured=_BACKEND_JD,
        candidates=[
            BatchCandidateInput(candidateId=good_id, profile=_strong_profile()),
            BatchCandidateInput(candidateId=bad_id, profile=_weak_profile()),
        ],
    )
    results = await score_batch(req)

    # The failing candidate is omitted; the good one still scores.
    assert len(results) == 1
    assert results[0][0].candidateId == good_id


# ── eval harness (offline golden-set gate) ──────────────────────────────────────
@pytest.mark.asyncio
async def test_eval_harness_runs_offline() -> None:
    """The Module 1 eval suite must run end-to-end without network (CI gate)."""
    summary = await run_evals()
    assert summary.n >= 5  # spec: >=5 labelled golden examples
    # Deterministic offline path should rank cases sensibly: within-1-tier high,
    # and the top-3 by score should be dominated by the good (A/B) labels.
    assert summary.within_one_accuracy >= 0.8
    assert summary.precision_at_3 >= 0.66
    # Every case produced a valid tier.
    assert all(c.actual_tier in {"A", "B", "C", "D"} for c in summary.cases)
