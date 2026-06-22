"""Unit tests for Module 8 — Internal Talent Marketplace / Internal Mobility AI surface.

All tests run WITHOUT network:
  - the offline path (no ANTHROPIC_API_KEY) exercises the deterministic move recommendation
    (templated fitSummary + one step per missing skill, clearly marked),
  - the LLM path is exercised by monkeypatching ``call_llm`` so we assert the grounding
    plumbing: the inputs reach the prompt; valid JSON is parsed; grounding is ENFORCED — the
    developmentPlan covers EXACTLY the missing skills (a model that invents a skill or turns
    an already-matched skill into a step is corrected; an omitted missing skill is
    back-filled), and the biasCheck is forced clean.

camelCase wire shape throughout (the API has already Zod-validated the requests).
"""

from __future__ import annotations

import json

import pytest
from app.config import Settings
from app.mobility import recommend_move
from app.schemas import (
    MobilityEmployeeContext,
    MobilityRecommendRequest,
)

_ORG = "00000000-0000-0000-0000-000000000001"
_PROMPT_VERSION = "module8.mobility_recommend@1.0.0"


def _offline_settings() -> Settings:
    """Settings with no Anthropic key — forces the deterministic offline fallback."""
    return Settings(anthropic_api_key=None)


def _online_settings() -> Settings:
    """Settings with a (fake) key so the surface takes the LLM path; call_llm is stubbed."""
    return Settings(anthropic_api_key="sk-test-not-real")


def _req(
    *,
    matched: list[str],
    missing: list[str],
    required: list[str] | None = None,
    readiness: str = "READY_SOON",
) -> MobilityRecommendRequest:
    """A move-recommendation request with a non-PII employee context."""
    return MobilityRecommendRequest(
        orgId=_ORG,
        targetRoleTitle="Engineering Manager",
        requiredSkills=required if required is not None else matched + missing,
        matchedSkills=matched,
        missingSkills=missing,
        readiness=readiness,  # type: ignore[arg-type]
        employeeContext=MobilityEmployeeContext(
            roleTitle="Senior Engineer", level="SENIOR", department="Engineering"
        ),
    )


# ═══ Offline fallback — works with no key, one step per missing skill ══════════════
@pytest.mark.asyncio
async def test_offline_fallback_one_step_per_missing_skill() -> None:
    """Offline (no key): a clearly-marked fit summary + exactly one step per missing skill."""
    req = _req(
        matched=["Python", "System Design", "Stakeholder Communication"],
        missing=["People Management", "Budgeting"],
        readiness="READY_SOON",
    )
    resp = await recommend_move(req, settings=_offline_settings())

    # Clearly-marked offline output.
    assert "+offline_fallback" in resp.modelVersion
    assert resp.promptVersion == _PROMPT_VERSION
    assert "[OFFLINE]" in resp.fitSummary

    # One development step per missing skill, in order.
    assert [s.skill for s in resp.developmentPlan] == ["People Management", "Budgeting"]
    # Every step has a concrete action; the offline path always supplies a resource.
    for step in resp.developmentPlan:
        assert step.action
        assert step.suggestedResource is not None

    # Bias guard: the recommendation is based purely on the skill match.
    assert resp.biasCheck.biasIndicatorsDetected == []
    assert resp.biasCheck.correctionApplied is False


@pytest.mark.asyncio
async def test_offline_fallback_ready_now_empty_plan() -> None:
    """READY_NOW with no missing skills -> an empty development plan (nothing invented)."""
    req = _req(
        matched=["Interaction Design", "Design Systems", "User Research"],
        missing=[],
        readiness="READY_NOW",
    )
    resp = await recommend_move(req, settings=_offline_settings())
    assert resp.developmentPlan == []
    assert "[OFFLINE]" in resp.fitSummary
    # Summary acknowledges full coverage.
    assert "every skill" in resp.fitSummary.lower()
    assert resp.confidence == "high"


@pytest.mark.asyncio
async def test_offline_fallback_dedupes_missing_skills() -> None:
    """A duplicate missing skill yields exactly one step (defensive de-dupe)."""
    req = _req(
        matched=["SQL"],
        missing=["Machine Learning", "Machine Learning", "Statistics"],
        readiness="STRETCH",
    )
    resp = await recommend_move(req, settings=_offline_settings())
    assert [s.skill for s in resp.developmentPlan] == ["Machine Learning", "Statistics"]
    # STRETCH moves carry lower stated confidence.
    assert resp.confidence == "medium"


# ═══ LLM path — grounding ENFORCED (call_llm stubbed; no network) ══════════════════
@pytest.mark.asyncio
async def test_llm_path_drops_invented_and_matched_backfills_omitted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The surface ENFORCES grounding: the developmentPlan covers EXACTLY the missing skills.

    The stub model returns a step for an INVENTED skill and for an ALREADY-MATCHED skill
    (both must be DROPPED) and OMITS a genuine missing skill (must be BACK-FILLED).
    """
    seen: dict[str, str] = {}

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        seen["user"] = req.user  # type: ignore[attr-defined]
        return json.dumps(
            {
                "fitSummary": "You bring strong technical depth for Engineering Manager.",
                "developmentPlan": [
                    {
                        "skill": "People Management",  # genuine missing skill — kept
                        "action": "Mentor a small group to practise coaching.",
                        "suggestedResource": "A first-time-manager course",
                    },
                    {
                        "skill": "Public Speaking",  # INVENTED — not a missing skill — DROP
                        "action": "nope",
                        "suggestedResource": "x",
                    },
                    {
                        "skill": "Python",  # ALREADY MATCHED — not a gap — DROP
                        "action": "nope",
                        "suggestedResource": "x",
                    },
                    # "Budgeting" (a genuine missing skill) is OMITTED — must be BACK-FILLED.
                ],
                "confidence": "high",
                "biasCheck": {"biasIndicatorsDetected": [], "correctionApplied": False},
            }
        )

    monkeypatch.setattr("app.mobility.recommend.call_llm", _fake_call_llm)
    req = _req(
        matched=["Python", "System Design", "Stakeholder Communication"],
        missing=["People Management", "Budgeting"],
        readiness="READY_SOON",
    )
    resp = await recommend_move(req, settings=_online_settings())

    # The inputs reached the prompt.
    assert "Engineering Manager" in seen["user"]
    assert "People Management" in seen["user"]

    # Not the offline marker — the LLM path was taken.
    assert resp.modelVersion == "claude-sonnet-4-6"
    assert "+offline_fallback" not in resp.modelVersion

    # The plan covers EXACTLY the missing skills, in target-role order.
    assert [s.skill for s in resp.developmentPlan] == ["People Management", "Budgeting"]
    plan_skills = {s.skill for s in resp.developmentPlan}
    # Invented + already-matched skills were dropped.
    assert "Public Speaking" not in plan_skills
    assert "Python" not in plan_skills
    # The omitted missing skill was back-filled with a templated step.
    by_skill = {s.skill: s for s in resp.developmentPlan}
    assert by_skill["Budgeting"].action  # non-empty back-filled action
    assert by_skill["Budgeting"].suggestedResource is not None
    # The model's kept step is preserved verbatim.
    assert by_skill["People Management"].suggestedResource == "A first-time-manager course"

    # Bias guard forced clean regardless of model output.
    assert resp.biasCheck.biasIndicatorsDetected == []
    assert resp.biasCheck.correctionApplied is False


@pytest.mark.asyncio
async def test_llm_path_never_includes_already_matched_skill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A development step is NEVER produced for an already-matched skill (grounding)."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        # The model wrongly turns every required skill (incl. matched ones) into a step.
        return json.dumps(
            {
                "fitSummary": "Great fit.",
                "developmentPlan": [
                    {"skill": "SQL", "action": "x", "suggestedResource": None},
                    {"skill": "Statistics", "action": "x", "suggestedResource": None},
                    {"skill": "Machine Learning", "action": "x", "suggestedResource": None},
                ],
                "confidence": "medium",
                "biasCheck": {"biasIndicatorsDetected": [], "correctionApplied": False},
            }
        )

    monkeypatch.setattr("app.mobility.recommend.call_llm", _fake_call_llm)
    req = _req(
        matched=["SQL", "Python"],
        missing=["Statistics", "Machine Learning"],
        readiness="STRETCH",
    )
    resp = await recommend_move(req, settings=_online_settings())

    plan_skills = [s.skill for s in resp.developmentPlan]
    # Only the genuine missing skills survive; matched "SQL" is dropped.
    assert plan_skills == ["Statistics", "Machine Learning"]
    assert "SQL" not in plan_skills
    assert "Python" not in plan_skills


@pytest.mark.asyncio
async def test_llm_path_forces_bias_check_clean_even_if_model_reports_otherwise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """biasCheck is FORCED clean regardless of what the model self-reports (standard #4)."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        # Model wrongly self-reports a bias indicator + a correction.
        return json.dumps(
            {
                "fitSummary": "Solid internal move.",
                "developmentPlan": [
                    {
                        "skill": "People Management",
                        "action": "Lead a small team.",
                        "suggestedResource": None,
                    }
                ],
                "confidence": "high",
                "biasCheck": {
                    "biasIndicatorsDetected": ["age", "tenure"],
                    "correctionApplied": True,
                },
            }
        )

    monkeypatch.setattr("app.mobility.recommend.call_llm", _fake_call_llm)
    req = _req(
        matched=["Python", "System Design"],
        missing=["People Management"],
        readiness="READY_SOON",
    )
    resp = await recommend_move(req, settings=_online_settings())

    # Forced clean — the model's self-report is overridden.
    assert resp.biasCheck.biasIndicatorsDetected == []
    assert resp.biasCheck.correctionApplied is False
    assert resp.promptVersion == _PROMPT_VERSION
