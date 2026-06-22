"""Unit tests for Module 2 — Recruiter Copilot (2a JD writer, 2b outreach, 2c chat
tools/agent, 2d LinkedIn).

All tests run WITHOUT network:
  - the generation surfaces (jd_writer / outreach / linkedin summary) exercise the
    OFFLINE deterministic fallback (no ANTHROPIC_API_KEY) and assert schema-shaped output,
  - the chat tool wrappers stub httpx to assert they POST the correct shape WITH the
    ``x-internal-secret`` header to the right internal endpoint,
  - the LinkedIn matcher is asserted to reuse the Module 1 skill_match.
"""

from __future__ import annotations

import pytest
from app.config import Settings
from app.copilot.chat_agent import run_recruiter_chat
from app.copilot.inclusive_language import build_inclusive_report, scan_inclusive_language
from app.copilot.jd_writer import write_job_description
from app.copilot.linkedin import analyze_linkedin, scraped_to_profile
from app.copilot.outreach import generate_outreach
from app.copilot.tools import ToolUnavailable, dispatch_tool, search_candidates
from app.schemas import (
    AnalyzeLinkedInRequest,
    CandidateProfile,
    CandidateSkill,
    GenerateOutreachRequest,
    JDStructured,
    LinkedInEducation,
    LinkedInExperience,
    LinkedInMatchRole,
    LinkedInScrapedProfile,
    RecruiterChatRequest,
    RequiredSkill,
    WorkExperience,
    WriteJobDescriptionRequest,
)

_ORG = "00000000-0000-0000-0000-000000000001"
_JOB = "00000000-0000-0000-0000-000000000002"
_CAND = "00000000-0000-0000-0000-000000000003"


def _offline_settings() -> Settings:
    """Settings with no Anthropic key (forces the offline fallback) and no API secret."""
    return Settings(anthropic_api_key=None, ai_service_secret=None)


def _configured_settings() -> Settings:
    """Settings with a service secret so the callback tools attempt the internal call."""
    return Settings(
        anthropic_api_key=None,
        ai_service_secret="test-secret-123",
        peopleos_api_url="http://api.test:3001",
    )


def _skill(name: str) -> CandidateSkill:
    return CandidateSkill(canonicalName=name, category="TECHNICAL", confidence=0.6)


# ═══ 2a — JD WRITER ════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_jd_writer_offline_produces_valid_schema_shaped_output() -> None:
    req = WriteJobDescriptionRequest(
        orgId=_ORG,
        roleTitle="Senior Backend Engineer",
        seniority="SENIOR",
        department="Engineering",
        teamContext="Payments Platform",
        hiringManagerNotes="Owns Go + Kafka services; mentors two mids.",
        priorJdExamples=["Prior JD text for tone matching."],
    )
    out = await write_job_description(req, settings=_offline_settings())

    # Schema-shaped: all required GeneratedJobDescription fields are present + typed.
    assert out.title == "Senior Backend Engineer"
    assert isinstance(out.summary, str) and out.summary
    assert isinstance(out.responsibilities, list) and out.responsibilities
    assert isinstance(out.requirements, list)
    assert isinstance(out.preferred, list)
    assert isinstance(out.benefits, list)
    assert out.deiStatement  # DEI statement is mandatory
    # jdText is assembled and contains the title + a section heading.
    assert "Senior Backend Engineer" in out.jdText
    assert "Responsibilities" in out.jdText
    # Inclusive-language report exists with a biasCheck.
    assert out.inclusiveLanguage.biasCheck is not None
    # Offline path is clearly marked in modelVersion + the prompt version is recorded.
    assert "offline_fallback" in out.modelVersion
    assert out.promptVersion is not None
    # The offline draft itself uses inclusive language (no flagged terms).
    assert out.inclusiveLanguage.flagged == []


def test_inclusive_language_flags_masculine_coded_and_suggests() -> None:
    flags = scan_inclusive_language("We want a rockstar ninja who is aggressive and competitive.")
    phrases = {f.phrase for f in flags}
    assert "rockstar" in phrases
    assert "ninja" in phrases
    # Every flag carries a category and a non-empty suggestion.
    assert all(f.suggestion for f in flags)
    cats = {f.category for f in flags}
    assert "GENDERED" in cats


def test_inclusive_report_records_categories_in_bias_check() -> None:
    report = build_inclusive_report("Looking for a young digital native, native English speaker.")
    assert report.flagged  # something was flagged
    indicators = report.biasCheck.biasIndicatorsDetected
    assert "age_language" in indicators
    assert "exclusionary_language" in indicators
    # Not auto-rewritten (flags are advisory suggestions).
    assert report.biasCheck.correctionApplied is False


def test_inclusive_language_clean_text_no_flags() -> None:
    assert scan_inclusive_language("We seek a collaborative, skilled, motivated engineer.") == []


# ═══ 2b — OUTREACH ═════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_outreach_offline_one_variant_per_requested_tone() -> None:
    profile = CandidateProfile(
        name="Priya Nair",
        experience=[
            WorkExperience(company="FinShield", title="Staff Data Engineer", isCurrent=True)
        ],
        skills=[_skill("Spark"), _skill("Kafka")],
    )
    req = GenerateOutreachRequest(
        orgId=_ORG,
        jobId=_JOB,
        candidateId=_CAND,
        profile=profile,
        jobTitle="Senior Data Engineer",
        recruiterName="Maya",
        tones=["WARM", "FORMAL", "BRIEF"],
    )
    out = await generate_outreach(req, settings=_offline_settings())

    # One variant per requested tone, in order.
    assert [v.tone for v in out.variants] == ["WARM", "FORMAL", "BRIEF"]
    # Every variant has a subject + body; the InMail + A/B subject variants exist.
    assert all(v.subject and v.body for v in out.variants)
    assert out.inMail.body
    assert len(out.subjectVariants) >= 1
    # Personalisation references a concrete profile detail (recruiter name appears too).
    assert any("Maya" in v.body for v in out.variants)
    assert "offline_fallback" in out.modelVersion
    assert out.biasCheck is not None
    assert out.promptVersion is not None


@pytest.mark.asyncio
async def test_outreach_sparse_profile_neutral_greeting() -> None:
    # No name -> neutral greeting, no fabricated personalisation.
    profile = CandidateProfile(skills=[_skill("Python")])
    req = GenerateOutreachRequest(
        orgId=_ORG,
        jobId=_JOB,
        candidateId=_CAND,
        profile=profile,
        jobTitle="Backend Engineer",
        recruiterName="Sam",
        tones=["FORMAL"],
    )
    out = await generate_outreach(req, settings=_offline_settings())
    assert len(out.variants) == 1
    assert out.variants[0].tone == "FORMAL"
    assert "Sam" in out.variants[0].body


# ═══ 2c — CHAT TOOLS + AGENT ═══════════════════════════════════════════════════
class _FakeResponse:
    """Minimal httpx.Response stand-in for the stubbed AsyncClient."""

    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return self._payload


class _FakeAsyncClient:
    """Captures the POST args so tests can assert URL + header + body shape."""

    last_call: dict[str, object] = {}

    def __init__(self, *_args: object, **_kwargs: object) -> None:
        pass

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    async def post(
        self,
        url: str,
        *,
        json: dict[str, object],
        headers: dict[str, str],
    ) -> _FakeResponse:
        _FakeAsyncClient.last_call = {"url": url, "json": json, "headers": headers}
        # Return a valid ToolSearchCandidatesResponse-shaped payload.
        return _FakeResponse(
            {
                "candidates": [
                    {
                        "candidateId": _CAND,
                        "name": "Ada Lovelace",
                        "headline": "ML Engineer",
                        "topSkills": ["Python", "PyTorch"],
                    }
                ]
            }
        )


@pytest.mark.asyncio
async def test_search_candidates_posts_correct_shape_with_secret_header(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    settings = _configured_settings()

    result = await search_candidates(
        org_id=_ORG, query="senior ML engineers", job_id=_JOB, settings=settings
    )

    call = _FakeAsyncClient.last_call
    # Correct internal endpoint.
    assert call["url"] == "http://api.test:3001/internal/copilot/search-candidates"
    # Service-secret header present and correct (server-to-server auth).
    assert call["headers"]["x-internal-secret"] == "test-secret-123"
    # orgId is in the BODY (tenant scope), supplied by the caller — never the model.
    assert call["json"]["orgId"] == _ORG
    assert call["json"]["query"] == "senior ML engineers"
    assert call["json"]["jobId"] == _JOB
    # Response validated + summarised (no raw dump).
    assert result.ok is True
    assert "Ada Lovelace" in result.summary


@pytest.mark.asyncio
async def test_callback_tool_unavailable_without_secret() -> None:
    # No ai_service_secret -> the callback tool cannot run.
    settings = _offline_settings()
    with pytest.raises(ToolUnavailable):
        await search_candidates(org_id=_ORG, query="anyone", job_id=None, settings=settings)


@pytest.mark.asyncio
async def test_dispatch_tool_injects_org_and_default_job(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    settings = _configured_settings()

    # The model omits orgId entirely and omits jobId; dispatch must inject orgId from
    # the request and fall back to default_job_id for jobId.
    result = await dispatch_tool(
        name="search_candidates",
        tool_input={"query": "data engineers"},  # note: NO orgId from the model
        org_id=_ORG,
        default_job_id=_JOB,
        settings=settings,
    )
    assert result.ok is True
    call = _FakeAsyncClient.last_call
    assert call["json"]["orgId"] == _ORG  # injected from request, not the model
    assert call["json"]["jobId"] == _JOB  # fell back to active pipeline context


@pytest.mark.asyncio
async def test_dispatch_schedule_interview_is_stub() -> None:
    result = await dispatch_tool(
        name="schedule_interview",
        tool_input={"candidateId": _CAND},
        org_id=_ORG,
        default_job_id=_JOB,
        settings=_offline_settings(),
    )
    assert result.ok is False
    assert "not yet available" in result.summary.lower()


@pytest.mark.asyncio
async def test_dispatch_unknown_tool_returns_failed_result() -> None:
    result = await dispatch_tool(
        name="not_a_real_tool",
        tool_input={},
        org_id=_ORG,
        default_job_id=None,
        settings=_offline_settings(),
    )
    assert result.ok is False
    assert "unknown tool" in result.summary.lower()


@pytest.mark.asyncio
async def test_chat_offline_returns_marked_stub() -> None:
    # No ANTHROPIC_API_KEY -> the ReAct loop cannot run; a clearly-marked stub is returned.
    req = RecruiterChatRequest(
        orgId=_ORG,
        messages=[{"role": "user", "content": "Find me 5 ML candidates."}],
        jobId=_JOB,
    )
    out = await run_recruiter_chat(req, settings=_offline_settings())
    assert out.modelVersion == "offline_stub"
    assert "OFFLINE STUB" in out.answer
    assert out.toolTrace == []


@pytest.mark.asyncio
async def test_chat_react_loop_runs_tools_then_answers(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A stubbed LLM tool-loop: turn 1 requests a tool, turn 2 gives the final answer.

    Asserts the agent ran the tool (org/job injected), recorded a trace entry with the
    short summary (no raw data dump), and returned the model's final text.
    """
    import httpx
    from app.copilot import chat_agent
    from app.llm import LLMToolTurn, ToolUseBlock

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    calls = {"n": 0}

    async def fake_call_llm_tools(**_kwargs: object) -> LLMToolTurn:
        calls["n"] += 1
        if calls["n"] == 1:
            return LLMToolTurn(
                stop_reason="tool_use",
                text="",
                tool_uses=[
                    ToolUseBlock(
                        id="tu_1",
                        name="search_candidates",
                        input={"query": "ML engineers"},
                    )
                ],
                raw_content=[
                    {"type": "tool_use", "id": "tu_1", "name": "search_candidates", "input": {"query": "ML engineers"}}
                ],
            )
        return LLMToolTurn(
            stop_reason="end_turn",
            text="I found one strong match: Ada Lovelace (ML Engineer).",
            tool_uses=[],
            raw_content=[{"type": "text", "text": "I found one strong match: Ada Lovelace (ML Engineer)."}],
        )

    monkeypatch.setattr(chat_agent, "call_llm_tools", fake_call_llm_tools)
    settings = _configured_settings()

    req = RecruiterChatRequest(
        orgId=_ORG,
        messages=[{"role": "user", "content": "Find me ML candidates."}],
        jobId=_JOB,
    )
    out = await run_recruiter_chat(req, settings=settings)

    assert calls["n"] == 2  # one tool step + one final answer
    assert "Ada Lovelace" in out.answer
    assert out.modelVersion == settings.model_version
    # Exactly one tool invocation recorded, with a short summary (no raw data dump).
    assert len(out.toolTrace) == 1
    assert out.toolTrace[0].tool == "search_candidates"
    assert out.toolTrace[0].ok is True
    assert out.toolTrace[0].resultSummary and "Ada Lovelace" in out.toolTrace[0].resultSummary
    # The tool was called tenant-scoped to the request's orgId.
    assert _FakeAsyncClient.last_call["json"]["orgId"] == _ORG


# ═══ 2d — LINKEDIN ═════════════════════════════════════════════════════════════
def test_scraped_to_profile_normalises_skills() -> None:
    scraped = LinkedInScrapedProfile(
        url="https://linkedin.com/in/janedoe",
        name="Jane Doe",
        headline="Backend Engineer",
        location="Berlin",
        about="Backend engineer.",
        experience=[
            LinkedInExperience(company="Acme", title="Engineer", dateRange="2019-2023", description="Built Go services.")
        ],
        education=[LinkedInEducation(school="TU Berlin", degree="BSc", field="CS")],
        skills=["Golang", "React.js"],  # aliases that must canonicalise
    )
    profile = scraped_to_profile(scraped)
    canon = {s.canonicalName for s in profile.skills}
    # Reuses the resume pipeline's alias table: Golang -> Go, React.js -> React.
    assert "Go" in canon
    assert "React" in canon
    assert profile.linkedinUrl == "https://linkedin.com/in/janedoe"
    assert profile.name == "Jane Doe"


@pytest.mark.asyncio
async def test_linkedin_analyze_reuses_skill_match_for_role_match(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """The LinkedIn role match must reuse Module 1's score_skill_match.

    We spy on app.copilot.linkedin.score_skill_match to prove it is the matcher, and
    assert the produced LinkedInRoleMatch reflects full coverage for a matching role.
    """
    from app.copilot import linkedin as linkedin_mod

    real = linkedin_mod.score_skill_match
    seen = {"called": 0}

    def spy(profile, jd):  # type: ignore[no-untyped-def]
        seen["called"] += 1
        return real(profile, jd)

    monkeypatch.setattr(linkedin_mod, "score_skill_match", spy)

    scraped = LinkedInScrapedProfile(
        url="https://linkedin.com/in/devgo",
        name="Dev Go",
        headline="Backend Engineer",
        skills=["Go", "Kafka"],
    )
    role = LinkedInMatchRole(
        jobId=_JOB,
        title="Senior Backend Engineer",
        jdText=None,
        jdStructured=JDStructured(
            requiredSkills=[
                RequiredSkill(canonicalName="Go", importance="CRITICAL"),
                RequiredSkill(canonicalName="Kafka", importance="CRITICAL"),
            ],
            requiredYoe=5,
            roleLevel="SENIOR",
        ),
    )
    req = AnalyzeLinkedInRequest(orgId=_ORG, profile=scraped, consent=True, roles=[role])
    out = await analyze_linkedin(req, settings=_offline_settings())

    assert seen["called"] == 1  # the Module 1 matcher was used
    assert len(out.roleMatches) == 1
    match = out.roleMatches[0]
    assert match.jobId == _JOB
    assert match.skillMatchPct == pytest.approx(100.0)  # full coverage
    assert match.matchScore == pytest.approx(1.0)
    assert match.tier == "A"
    assert match.topGaps == []
    # Structured profile is returned; summary + biasCheck present; offline marked.
    assert out.candidateProfile.name == "Dev Go"
    assert out.summary
    assert out.biasCheck is not None
    assert "offline_fallback" in out.modelVersion


@pytest.mark.asyncio
async def test_linkedin_analyze_role_without_requirements_flags_gap() -> None:
    scraped = LinkedInScrapedProfile(url="https://linkedin.com/in/x", name="X", skills=["Python"])
    role = LinkedInMatchRole(jobId=_JOB, title="Mystery Role", jdText=None, jdStructured=None)
    req = AnalyzeLinkedInRequest(orgId=_ORG, profile=scraped, consent=True, roles=[role])
    out = await analyze_linkedin(req, settings=_offline_settings())
    assert len(out.roleMatches) == 1
    assert out.roleMatches[0].topGaps  # flags missing structured requirements
