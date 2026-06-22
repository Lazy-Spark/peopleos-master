"""Unit tests for Module 6 — Employee Skill Graph AI surfaces.

All tests run WITHOUT network:
  - the offline path (no ANTHROPIC_API_KEY) exercises the deterministic growth path
    (stepsAway = set difference + templated recs) and the build-vs-buy decision rule,
  - the LLM path is exercised by monkeypatching ``call_llm`` so we assert the grounding
    plumbing (the inputs reach the prompt; valid JSON is parsed; grounding is ENFORCED).

camelCase wire shape throughout (the API has already Zod-validated the requests).
"""

from __future__ import annotations

import json

import pytest
from app.config import Settings
from app.schemas import (
    BuildVsBuyRequest,
    EmployeeSkillBrief,
    GrowthPathRequest,
)
from app.skills import generate_growth_path, recommend_build_vs_buy
from app.skills.build_vs_buy import decide

_ORG = "00000000-0000-0000-0000-000000000001"


def _offline_settings() -> Settings:
    """Settings with no Anthropic key — forces the deterministic offline fallback."""
    return Settings(anthropic_api_key=None)


def _online_settings() -> Settings:
    """Settings with a (fake) key so the surfaces take the LLM path; call_llm is stubbed."""
    return Settings(anthropic_api_key="sk-test-not-real")


# ═══ Growth path — offline set-difference grounding ════════════════════════════════
@pytest.mark.asyncio
async def test_growth_path_offline_steps_away_is_set_difference() -> None:
    """stepsAway = the count of target-required skills the employee LACKS (set difference)."""
    req = GrowthPathRequest(
        orgId=_ORG,
        employeeSkills=[
            EmployeeSkillBrief(name="Python", proficiency="ADVANCED"),
            EmployeeSkillBrief(name="Machine Learning", proficiency="PRACTITIONER"),
        ],
        targetRoleTitle="Senior ML Engineer",
        targetRequiredSkills=["Python", "Machine Learning", "MLOps", "System Design"],
        skillCatalog=["MLOps Fundamentals (internal course)"],
    )
    resp = await generate_growth_path(req, settings=_offline_settings())

    # Clearly-marked offline output.
    assert "+offline_fallback" in resp.modelVersion
    assert resp.promptVersion == "module6.growth_path@1.0.0"
    assert "[OFFLINE]" in resp.summary

    # stepsAway = |{MLOps, System Design}| = 2 (Python + ML are already held).
    assert resp.stepsAway == 2
    rec_skills = {r.skill for r in resp.recommendedSkills}
    assert rec_skills == {"MLOps", "System Design"}
    # One rec per missing skill — len matches stepsAway.
    assert len(resp.recommendedSkills) == resp.stepsAway

    # Catalog match is used where one exists; a generic suggestion otherwise.
    by_skill = {r.skill: r for r in resp.recommendedSkills}
    assert by_skill["MLOps"].suggestedTraining == "MLOps Fundamentals (internal course)"
    assert by_skill["System Design"].suggestedTraining is not None  # generic, not null

    # Bias guard: growth is based purely on the skill gap.
    assert resp.biasCheck.biasIndicatorsDetected == []
    assert resp.biasCheck.correctionApplied is False


@pytest.mark.asyncio
async def test_growth_path_offline_never_recommends_held_skill() -> None:
    """A skill the employee already holds is NEVER recommended (grounding)."""
    req = GrowthPathRequest(
        orgId=_ORG,
        employeeSkills=[
            EmployeeSkillBrief(name="SQL", proficiency="EXPERT"),
            EmployeeSkillBrief(name="dbt", proficiency="PRACTITIONER"),
        ],
        targetRoleTitle="Analytics Engineer",
        targetRequiredSkills=["SQL", "Data Modeling", "dbt"],
    )
    resp = await generate_growth_path(req, settings=_offline_settings())

    # Only "Data Modeling" is missing.
    assert resp.stepsAway == 1
    rec_skills = {r.skill for r in resp.recommendedSkills}
    assert rec_skills == {"Data Modeling"}
    # Held skills are absent from the recommendations.
    assert "SQL" not in rec_skills
    assert "dbt" not in rec_skills


@pytest.mark.asyncio
async def test_growth_path_offline_zero_steps_when_all_held() -> None:
    """When the employee holds every required skill, stepsAway == 0 and no recs."""
    req = GrowthPathRequest(
        orgId=_ORG,
        employeeSkills=[
            EmployeeSkillBrief(name="Go", proficiency="EXPERT"),
            EmployeeSkillBrief(name="Kubernetes", proficiency="ADVANCED"),
        ],
        targetRoleTitle="Platform Engineer",
        targetRequiredSkills=["Go", "Kubernetes"],
    )
    resp = await generate_growth_path(req, settings=_offline_settings())
    assert resp.stepsAway == 0
    assert resp.recommendedSkills == []


@pytest.mark.asyncio
async def test_growth_path_offline_match_is_case_insensitive_and_deduped() -> None:
    """Held-skill matching is case-insensitive and duplicate required skills count once."""
    req = GrowthPathRequest(
        orgId=_ORG,
        employeeSkills=[EmployeeSkillBrief(name="python", proficiency="ADVANCED")],
        targetRoleTitle="Backend Engineer",
        # "Python" matches held "python"; "SQL" listed twice should count once.
        targetRequiredSkills=["Python", "SQL", "SQL"],
    )
    resp = await generate_growth_path(req, settings=_offline_settings())
    assert resp.stepsAway == 1
    assert [r.skill for r in resp.recommendedSkills] == ["SQL"]


# ═══ Growth path — LLM path grounding plumbing (call_llm stubbed; no network) ══════
@pytest.mark.asyncio
async def test_growth_path_llm_path_grounds_and_drops_invented_skill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The surface ENFORCES grounding: it recomputes stepsAway and drops any recommended
    skill that is not a genuine missing required skill (here the model invents one)."""
    seen: dict[str, str] = {}

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        seen["user"] = req.user  # type: ignore[attr-defined]
        return json.dumps(
            {
                "summary": "You are a couple of skills away from Senior ML Engineer.",
                "stepsAway": 3,  # WRONG on purpose — must be overridden to the true 2
                "recommendedSkills": [
                    {"skill": "MLOps", "why": "Needed to ship models.", "suggestedTraining": None},
                    # Invented / not a missing required skill — must be DROPPED.
                    {"skill": "Public Speaking", "why": "nope", "suggestedTraining": "x"},
                    # An already-held skill — must be DROPPED.
                    {"skill": "Python", "why": "nope", "suggestedTraining": "x"},
                ],
                "confidence": "high",
                "biasCheck": {"biasIndicatorsDetected": [], "correctionApplied": False},
            }
        )

    monkeypatch.setattr("app.skills.growth_path.call_llm", _fake_call_llm)
    req = GrowthPathRequest(
        orgId=_ORG,
        employeeSkills=[
            EmployeeSkillBrief(name="Python", proficiency="ADVANCED"),
            EmployeeSkillBrief(name="Machine Learning", proficiency="PRACTITIONER"),
        ],
        targetRoleTitle="Senior ML Engineer",
        targetRequiredSkills=["Python", "Machine Learning", "MLOps", "System Design"],
    )
    resp = await generate_growth_path(req, settings=_online_settings())

    # The inputs reached the prompt.
    assert "Senior ML Engineer" in seen["user"]
    assert "MLOps" in seen["user"]

    # Not the offline marker.
    assert resp.modelVersion == "claude-sonnet-4-6"
    assert "+offline_fallback" not in resp.modelVersion

    # stepsAway is forced to the TRUE set difference (2), not the model's claimed 3.
    assert resp.stepsAway == 2
    rec_skills = {r.skill for r in resp.recommendedSkills}
    # Invented + already-held skills dropped; the missing one the model omitted back-filled.
    assert rec_skills == {"MLOps", "System Design"}
    assert "Public Speaking" not in rec_skills
    assert "Python" not in rec_skills
    assert len(resp.recommendedSkills) == 2

    # Bias guard forced regardless of model output.
    assert resp.biasCheck.biasIndicatorsDetected == []
    assert resp.biasCheck.correctionApplied is False


# ═══ Build vs Buy — the deterministic rule (offline + decide()) ════════════════════
def test_decide_rule_build_buy_hybrid() -> None:
    """The pure decision rule returns BUILD / BUY / HYBRID per the spec."""
    # No shortfall -> BUILD (deepen the bench).
    assert decide(current_supply=12, demand=8, trainable_internally=5) == ("BUILD", 0)
    # Gap fully coverable internally -> BUILD.
    assert decide(current_supply=3, demand=7, trainable_internally=6) == ("BUILD", 4)
    # Gap exactly coverable internally -> BUILD (>=).
    assert decide(current_supply=3, demand=7, trainable_internally=4) == ("BUILD", 4)
    # Gap, nobody trainable -> BUY.
    assert decide(current_supply=1, demand=4, trainable_internally=0) == ("BUY", 3)
    # Gap, some but not enough trainable -> HYBRID.
    assert decide(current_supply=4, demand=9, trainable_internally=2) == ("HYBRID", 5)


@pytest.mark.asyncio
async def test_build_vs_buy_offline_build() -> None:
    """BUILD when the internal pool can close the gap (offline)."""
    req = BuildVsBuyRequest(
        orgId=_ORG, skill="Kubernetes", currentSupply=3, demand=7, trainableInternally=6
    )
    resp = await recommend_build_vs_buy(req, settings=_offline_settings())
    assert resp.recommendation == "BUILD"
    assert "+offline_fallback" in resp.modelVersion
    assert resp.promptVersion == "module6.build_vs_buy@1.0.0"
    assert "[OFFLINE]" in resp.rationale
    # Rationale grounded in the supplied numbers (gap of 4, 6 trainable).
    assert "4" in resp.rationale


@pytest.mark.asyncio
async def test_build_vs_buy_offline_buy() -> None:
    """BUY when there is a gap and no one is trainable internally (offline)."""
    req = BuildVsBuyRequest(
        orgId=_ORG, skill="Rust", currentSupply=1, demand=4, trainableInternally=0
    )
    resp = await recommend_build_vs_buy(req, settings=_offline_settings())
    assert resp.recommendation == "BUY"
    assert "[OFFLINE]" in resp.rationale


@pytest.mark.asyncio
async def test_build_vs_buy_offline_hybrid() -> None:
    """HYBRID when some but not enough employees are trainable (offline)."""
    req = BuildVsBuyRequest(
        orgId=_ORG,
        skill="Data Engineering",
        currentSupply=4,
        demand=9,
        trainableInternally=2,
    )
    resp = await recommend_build_vs_buy(req, settings=_offline_settings())
    assert resp.recommendation == "HYBRID"
    assert "[OFFLINE]" in resp.rationale


@pytest.mark.asyncio
async def test_build_vs_buy_offline_build_when_supply_meets_demand() -> None:
    """No shortfall -> BUILD (deepen the bench), even with people trainable."""
    req = BuildVsBuyRequest(
        orgId=_ORG, skill="Python", currentSupply=12, demand=8, trainableInternally=5
    )
    resp = await recommend_build_vs_buy(req, settings=_offline_settings())
    assert resp.recommendation == "BUILD"


# ═══ Build vs Buy — LLM path: the rule is the source of truth for the verdict ══════
@pytest.mark.asyncio
async def test_build_vs_buy_llm_path_rule_overrides_model_verdict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The deterministic rule overrides a disagreeing model verdict; prose is kept."""
    seen: dict[str, str] = {}

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        seen["user"] = req.user  # type: ignore[attr-defined]
        # Model wrongly says BUY though the rule (gap 4, 6 trainable) says BUILD.
        return json.dumps(
            {"recommendation": "BUY", "rationale": "Just hire some people."}
        )

    monkeypatch.setattr("app.skills.build_vs_buy.call_llm", _fake_call_llm)
    req = BuildVsBuyRequest(
        orgId=_ORG, skill="Kubernetes", currentSupply=3, demand=7, trainableInternally=6
    )
    resp = await recommend_build_vs_buy(req, settings=_online_settings())

    assert "Kubernetes" in seen["user"]
    assert resp.modelVersion == "claude-sonnet-4-6"
    # Rule wins: BUILD, not the model's BUY.
    assert resp.recommendation == "BUILD"
    # The model's prose is preserved, with a note that the rule set the verdict.
    assert "Just hire some people." in resp.rationale
    assert "BUILD" in resp.rationale


@pytest.mark.asyncio
async def test_build_vs_buy_llm_path_agreement_keeps_rationale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the model agrees with the rule, its rationale is returned unmodified."""

    async def _fake_call_llm(req: object, settings: object | None = None) -> str:
        return json.dumps(
            {
                "recommendation": "BUY",
                "rationale": "Gap of 3 with nobody trainable — hire externally.",
            }
        )

    monkeypatch.setattr("app.skills.build_vs_buy.call_llm", _fake_call_llm)
    req = BuildVsBuyRequest(
        orgId=_ORG, skill="Rust", currentSupply=1, demand=4, trainableInternally=0
    )
    resp = await recommend_build_vs_buy(req, settings=_online_settings())
    assert resp.recommendation == "BUY"
    assert resp.rationale == "Gap of 3 with nobody trainable — hire externally."
    assert "set to" not in resp.rationale  # no override note appended
