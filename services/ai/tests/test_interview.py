"""Unit tests for Module 3 — Interview Intelligence & Summaries.

All tests run WITHOUT network / GPU:
  - the analysis surface exercises the OFFLINE deterministic fallback (no
    ANTHROPIC_API_KEY) and asserts schema-valid output,
  - asserts EVERY CompetencyScore carries a non-empty evidenceQuote (prompt standard #2:
    no score without evidence),
  - asserts a transcript with an off-limits interviewer question yields an
    ILLEGAL_QUESTION calibration flag (offline heuristic),
  - asserts the privacy guard: the candidate's volunteered protected disclosure never
    appears in any output field,
  - asserts the transcribe adapter degrades cleanly (TranscriptionUnavailable) offline.
"""

from __future__ import annotations

import pytest
from app.config import Settings
from app.interview.analyze import analyze_interview
from app.interview.transcribe import TranscriptionUnavailable, transcribe_interview
from app.schemas import (
    AnalyzeInterviewRequest,
    AnalyzeInterviewResponse,
    InterviewTranscript,
    ScorecardCompetency,
    ScorecardTemplate,
    TranscribeRequest,
    TranscriptSegment,
)

_ORG = "00000000-0000-0000-0000-000000000001"
_INT = "00000000-0000-0000-0000-000000000010"


def _offline_settings() -> Settings:
    """Settings with no Anthropic key (forces the offline analysis fallback)."""
    return Settings(anthropic_api_key=None)


def _seg(label: str, role: str, start: float, end: float, text: str) -> TranscriptSegment:
    return TranscriptSegment(
        speakerLabel=label, speakerRole=role, startSec=start, endSec=end, text=text
    )


def _template() -> ScorecardTemplate:
    return ScorecardTemplate(
        competencies=[
            ScorecardCompetency(competencyId="c_sys", name="System Design"),
            ScorecardCompetency(competencyId="c_comm", name="Communication"),
        ]
    )


def _clean_transcript() -> InterviewTranscript:
    return InterviewTranscript(
        source="UPLOAD",
        diarised=True,
        durationSec=180.0,
        language="en",
        segments=[
            _seg("Interviewer A", "INTERVIEWER", 0.0, 6.0,
                 "Tell me about a time you scaled a service under load."),
            _seg("Candidate", "CANDIDATE", 6.0, 40.0,
                 "At Northwind our checkout API was timing out at peak. I owned the fix "
                 "end to end. I profiled it, found an N+1 query, added Redis caching and a "
                 "read replica, and we cut p99 latency from 1.2s to 180ms with zero downtime."),
            _seg("Interviewer A", "INTERVIEWER", 40.0, 45.0,
                 "How do you keep stakeholders aligned on a project?"),
            _seg("Candidate", "CANDIDATE", 45.0, 70.0,
                 "I run a weekly written update and a short demo so engineering, design, "
                 "and the PM all see the same status; it cut surprise escalations a lot."),
        ],
    )


def _illegal_transcript() -> InterviewTranscript:
    """Interviewer asks an off-limits family-planning question; candidate discloses health."""
    return InterviewTranscript(
        source="UPLOAD",
        diarised=True,
        segments=[
            _seg("Interviewer B", "INTERVIEWER", 0.0, 5.0,
                 "Tell me about your approach to communication on a team."),
            _seg("Candidate", "CANDIDATE", 5.0, 30.0,
                 "I keep a weekly written update so everyone stays aligned. By the way I am "
                 "managing a chronic illness so I sometimes keep my notes brief."),
            _seg("Interviewer B", "INTERVIEWER", 30.0, 36.0,
                 "Do you have any kids at home that might affect your availability?"),
            _seg("Candidate", "CANDIDATE", 36.0, 42.0,
                 "I would rather keep my personal life separate, thanks."),
        ],
    )


def _assert_every_score_has_evidence(resp: AnalyzeInterviewResponse) -> None:
    scores = resp.scorecardDraft.competencyScores
    assert scores, "expected at least one competency score"
    for cs in scores:
        assert cs.evidenceQuote and cs.evidenceQuote.strip(), (
            f"competency {cs.competencyId} has no evidence quote (prompt standard #2)"
        )
        assert 1 <= cs.score <= 5


# ═══ ANALYSIS — offline fallback ══════════════════════════════════════════════
@pytest.mark.asyncio
async def test_analyze_offline_produces_schema_valid_output() -> None:
    req = AnalyzeInterviewRequest(
        orgId=_ORG,
        interviewId=_INT,
        jobTitle="Senior Backend Engineer",
        scorecardTemplate=_template(),
        transcript=_clean_transcript(),
    )
    resp = await analyze_interview(req, settings=_offline_settings())

    # Round-trips through the frozen contract model (schema-valid).
    assert isinstance(resp, AnalyzeInterviewResponse)
    AnalyzeInterviewResponse.model_validate(resp.model_dump())

    assert resp.modelVersion.endswith("+offline_fallback")
    assert resp.promptVersion == "module3.interview_analyze@1.0.0"

    # One competency score per template competency.
    assert len(resp.scorecardDraft.competencyScores) == 2
    ids = {cs.competencyId for cs in resp.scorecardDraft.competencyScores}
    assert ids == {"c_sys", "c_comm"}

    # 3-paragraph executive summary (blank-line separated).
    assert resp.scorecardDraft.summary.count("\n\n") >= 2

    # Per-Q/A competency evidence extracted with STAR dimensions in [0,1].
    assert resp.competencyEvidence
    for ev in resp.competencyEvidence:
        for dim in (ev.star.situation, ev.star.task, ev.star.action, ev.star.result):
            assert 0.0 <= dim <= 1.0
        assert 0.0 <= ev.starCompleteness <= 1.0


@pytest.mark.asyncio
async def test_analyze_every_competency_score_has_evidence_quote() -> None:
    req = AnalyzeInterviewRequest(
        orgId=_ORG,
        interviewId=_INT,
        jobTitle="Senior Backend Engineer",
        scorecardTemplate=_template(),
        transcript=_clean_transcript(),
    )
    resp = await analyze_interview(req, settings=_offline_settings())
    _assert_every_score_has_evidence(resp)


@pytest.mark.asyncio
async def test_analyze_with_empty_template_still_valid() -> None:
    """A transcript with no template competencies must not crash; evidence still extracted."""
    req = AnalyzeInterviewRequest(
        orgId=_ORG,
        interviewId=_INT,
        scorecardTemplate=ScorecardTemplate(competencies=[]),
        transcript=_clean_transcript(),
    )
    resp = await analyze_interview(req, settings=_offline_settings())
    AnalyzeInterviewResponse.model_validate(resp.model_dump())
    assert resp.scorecardDraft.competencyScores == []
    assert resp.competencyEvidence  # Q/A still extracted


# ═══ ANALYSIS — calibration flags (illegal question) ══════════════════════════
@pytest.mark.asyncio
async def test_analyze_flags_illegal_question() -> None:
    req = AnalyzeInterviewRequest(
        orgId=_ORG,
        interviewId=_INT,
        jobTitle="Product Manager",
        scorecardTemplate=ScorecardTemplate(
            competencies=[ScorecardCompetency(competencyId="c_comm", name="Communication")]
        ),
        transcript=_illegal_transcript(),
    )
    resp = await analyze_interview(req, settings=_offline_settings())

    illegal = [f for f in resp.calibrationFlags if f.type == "ILLEGAL_QUESTION"]
    assert illegal, "expected an ILLEGAL_QUESTION flag for the 'kids at home' question"
    flag = illegal[0]
    assert flag.illegalTopic == "FAMILY_PLANNING"
    assert flag.evidenceQuote and "kids" in flag.evidenceQuote.lower()
    # The grounded quote is the INTERVIEWER's question, not the candidate's answer.
    assert "personal life separate" not in (flag.evidenceQuote or "")


# ═══ ANALYSIS — privacy guard ═════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_analyze_offline_does_not_repeat_protected_disclosure() -> None:
    """The candidate's volunteered health disclosure must not appear in any output field."""
    req = AnalyzeInterviewRequest(
        orgId=_ORG,
        interviewId=_INT,
        jobTitle="Product Manager",
        scorecardTemplate=ScorecardTemplate(
            competencies=[ScorecardCompetency(competencyId="c_comm", name="Communication")]
        ),
        transcript=_illegal_transcript(),
    )
    resp = await analyze_interview(req, settings=_offline_settings())

    # Aggregate every free-text field the offline path can emit.
    blob_parts: list[str] = [resp.scorecardDraft.summary, *resp.scorecardDraft.keyReasons]
    for cs in resp.scorecardDraft.competencyScores:
        blob_parts.extend([cs.evidenceQuote, cs.rationale])
    for ev in resp.competencyEvidence:
        blob_parts.extend([ev.answerSummary, *ev.behaviouralIndicators])
    blob = " ".join(blob_parts).lower()
    # The offline fallback never surfaces the candidate's chronic-illness disclosure.
    assert "chronic illness" not in blob


# ═══ TRANSCRIPTION — clean offline degradation ════════════════════════════════
@pytest.mark.asyncio
async def test_transcribe_degrades_cleanly_offline() -> None:
    req = TranscribeRequest(
        orgId=_ORG,
        interviewId=_INT,
        audioUrl="s3://peopleos-interviews/abc.m4a",
        source="ZOOM",
        language="en",
    )
    with pytest.raises(TranscriptionUnavailable) as exc:
        await transcribe_interview(req, settings=Settings())
    assert exc.value.reason  # carries a human-readable reason for the API 503


@pytest.mark.asyncio
async def test_transcribe_disabled_flag_short_circuits() -> None:
    req = TranscribeRequest(
        orgId=_ORG,
        interviewId=_INT,
        audioUrl="s3://peopleos-interviews/abc.m4a",
        source="UPLOAD",
    )
    settings = Settings(transcription_enabled=False)
    with pytest.raises(TranscriptionUnavailable) as exc:
        await transcribe_interview(req, settings=settings)
    assert "disabled" in exc.value.reason.lower()
