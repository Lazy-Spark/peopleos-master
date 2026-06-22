"""Module 1 — Resume Screening & Candidate Ranking, as a LangGraph StateGraph.

Pipeline (spec Module 1) wired as typed StateGraph nodes; each node carries a
LangSmith trace/tag name (spec: "Specify the LangSmith trace name + tags for
every LangGraph node"):

  ensure_jd_structured  -> skill_match -> exp_relevance -> yoe -> mask_profile
  -> holistic_llm (CoT; <thinking> split + stored for audit) -> compose -> bias_audit

Composite score (spec step 5, weights configurable per org):
  final = skillMatch*w.skillMatch + expRelevance*w.expRelevance
        + holistic*w.holistic   + yoeMatch*w.yoeMatch

Tiers (spec step output A/B/C/D) by threshold on final_score.

Offline dev: when ANTHROPIC_API_KEY is absent the holistic node uses a CLEARLY
MARKED deterministic fallback (no LLM); embeddings likewise fall back to token
overlap. The whole graph therefore runs end-to-end with no network.

LangGraph is imported lazily inside ``score_candidate`` so the module imports
without the package installed (mypy treats it as untyped — see pyproject overrides).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, TypedDict

import structlog

from ..bias import mask_profile
from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm, split_thinking
from ..prompts.holistic_assessment import (
    PROMPT_VERSION as HOLISTIC_PROMPT_VERSION,
)
from ..prompts.holistic_assessment import (
    build_holistic_system_prompt,
    build_holistic_user_prompt,
)
from ..schemas import (
    BatchCandidateInput,
    BiasCheck,
    CandidateProfile,
    CandidateRanking,
    HolisticAssessment,
    JDStructured,
    RankingComponents,
    RankingWeights,
    ScoreBatchRequest,
    ScoreCandidateRequest,
)
from ..scoring.exp_relevance import score_experience_relevance
from ..scoring.skill_match import score_skill_match
from ..scoring.yoe import score_yoe_match
from ..validation import validate_or_review

log = structlog.get_logger(__name__)

# Tier thresholds on the composite final score (spec output A/B/C/D).
_TIER_A = 0.80
_TIER_B = 0.65
_TIER_C = 0.45


class RankerState(TypedDict, total=False):
    """Typed state threaded through the StateGraph."""

    # Inputs
    orgId: str
    jobId: str
    candidateId: str
    profile: CandidateProfile
    jd: JDStructured
    jdText: str | None
    weights: RankingWeights
    settings: Settings
    orgContext: dict[str, object] | None

    # Step outputs
    skillMatch: float
    skillMatchPct: float
    skillMatched: list[str]
    skillMissing: list[str]
    expRelevance: float
    expMethod: str
    yoeMatch: float
    maskedProfile: CandidateProfile
    holistic: HolisticAssessment
    # CoT stripped before returning; stored for audit (prompt standard #3).
    reasoningAudit: str
    holisticMethod: str

    # Final
    ranking: CandidateRanking


def _tier(score: float) -> str:
    if score >= _TIER_A:
        return "A"
    if score >= _TIER_B:
        return "B"
    if score >= _TIER_C:
        return "C"
    return "D"


# ── Nodes ─────────────────────────────────────────────────────────────────────
async def _node_ensure_jd_structured(state: RankerState) -> RankerState:
    """LangSmith: module1.ranker.ensure_jd_structured.

    If the request already carried jdStructured we use it; otherwise (jdText only)
    we parse it. Parsing is deferred-imported to avoid a cycle and to keep the
    offline fallback localised.
    """
    if state.get("jd") is not None:
        return {}
    jd_text = state.get("jdText")
    if not jd_text:
        # Nothing to score against; an empty JD yields neutral sub-scores.
        return {"jd": JDStructured()}
    from ..pipelines.jd_parse import parse_job_description
    from ..schemas import ParseJobDescriptionRequest

    resp = await parse_job_description(
        ParseJobDescriptionRequest(orgId=state["orgId"], jobId=state["jobId"], jdText=jd_text),
        settings=state["settings"],
    )
    return {"jd": resp.jdStructured}


async def _node_skill_match(state: RankerState) -> RankerState:
    """LangSmith: module1.ranker.skill_match (deterministic, spec step 2)."""
    result = score_skill_match(state["profile"], state["jd"])
    return {
        "skillMatch": result.skill_match,
        "skillMatchPct": result.skill_match_pct,
        "skillMatched": result.matched,
        "skillMissing": result.missing,
    }


async def _node_exp_relevance(state: RankerState) -> RankerState:
    """LangSmith: module1.ranker.exp_relevance (embeddings|token-overlap, step 3)."""
    result = await score_experience_relevance(state["profile"], state["jd"], settings=state["settings"])
    return {"expRelevance": result.exp_relevance, "expMethod": result.method}


async def _node_yoe(state: RankerState) -> RankerState:
    """LangSmith: module1.ranker.yoe (deterministic YoE match)."""
    return {"yoeMatch": score_yoe_match(state["profile"], state["jd"])}


async def _node_mask_profile(state: RankerState) -> RankerState:
    """LangSmith: module1.ranker.mask_profile (bias layer, spec step 6 / standard #4).

    Name/email/links removed, graduation years stripped, school names redacted
    BEFORE the holistic LLM ever sees the profile.
    """
    return {"maskedProfile": mask_profile(state["profile"])}


async def _node_holistic_llm(state: RankerState) -> RankerState:
    """LangSmith: module1.ranker.holistic_llm (CoT; <thinking> split + audit, step 4)."""
    settings = state["settings"]
    masked = state["maskedProfile"]
    jd = state["jd"]

    system = build_holistic_system_prompt(org_context=state.get("orgContext"))
    masked_json = masked.model_dump_json()
    jd_json = jd.model_dump_json()
    user = build_holistic_user_prompt(
        masked_profile_json=masked_json,
        jd_json=jd_json,
        skill_match=state["skillMatch"],
        exp_relevance=state["expRelevance"],
        yoe_match=state["yoeMatch"],
    )

    # The CoT we capture for audit; mutated by the closure below.
    captured: dict[str, str] = {"thinking": ""}

    async def _llm_call(prompt: str) -> str:
        raw = await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1536,
                temperature=0.2,
                run_name="module1.holistic_assessment",
                tags=["module1", "holistic", HOLISTIC_PROMPT_VERSION],
            ),
            settings=settings,
        )
        split = split_thinking(raw)
        # Store the stripped CoT for audit; only the answer is validated/returned.
        captured["thinking"] = split.thinking
        return split.answer

    try:
        holistic = await validate_or_review(
            HolisticAssessment,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={
                "orgId": state["orgId"],
                "jobId": state["jobId"],
                "candidateId": state["candidateId"],
            },
            module="module1",
            task="holistic_assessment",
        )
        return {
            "holistic": holistic,
            "reasoningAudit": captured["thinking"],
            "holisticMethod": "llm",
        }
    except LLMUnavailable:
        # OFFLINE FALLBACK — deterministic holistic estimate, clearly marked.
        log.info("holistic_offline_fallback", candidateId=state["candidateId"])
        holistic, reasoning = _heuristic_holistic(state)
        return {"holistic": holistic, "reasoningAudit": reasoning, "holisticMethod": "offline_fallback"}


def _heuristic_holistic(state: RankerState) -> tuple[HolisticAssessment, str]:
    """Deterministic offline holistic estimate (clearly marked stub).

    Blends the deterministic sub-scores so the offline pipeline produces a
    coherent, auditable result without any LLM. Confidence is conservative.
    """
    skill = state["skillMatch"]
    exp = state["expRelevance"]
    yoe = state["yoeMatch"]
    holistic_score = round(0.5 * skill + 0.35 * exp + 0.15 * yoe, 4)

    matched = state.get("skillMatched", [])
    missing = state.get("skillMissing", [])
    profile = state["profile"]

    strengths: list[str] = []
    if matched:
        strengths.append(f"Covers {len(matched)} required skill(s): {', '.join(matched[:5])}.")
    if exp >= 0.5:
        strengths.append("Prior experience descriptions align with the job responsibilities.")
    if not strengths:
        strengths.append("Limited but present evidence against the role requirements.")

    concerns: list[str] = []
    if missing:
        concerns.append(f"Missing required skill(s): {', '.join(missing[:5])}.")
    if profile.gaps:
        concerns.append(f"{len(profile.gaps)} employment gap/overlap detected (noted neutrally).")
    if exp < 0.3:
        concerns.append("Experience descriptions show limited direct relevance to the role.")

    interview_focus = [f"Probe depth on missing skill: {m}" for m in missing[:3]]
    if not interview_focus:
        interview_focus = ["Validate hands-on depth in the strongest matched skills."]

    confidence = "low"  # offline heuristic is never confident
    reasoning = (
        "[OFFLINE FALLBACK] No LLM available; holistic score derived deterministically "
        f"from sub-scores (skillMatch={skill:.2f}, expRelevance={exp:.2f}, yoeMatch={yoe:.2f}). "
        "Bias-masked profile was used; no identity signals were available to bias on."
    )
    holistic = HolisticAssessment(
        holisticScore=holistic_score,
        strengths=strengths,
        concerns=concerns,
        suggestedInterviewFocus=interview_focus,
        calibrationNote="Offline heuristic estimate; treat as advisory and verify with a real LLM run.",
        confidence=confidence,
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
    )
    return holistic, reasoning


async def _node_compose(state: RankerState) -> RankerState:
    """LangSmith: module1.ranker.compose (composite score + tier, spec step 5)."""
    w = state["weights"]
    holistic = state["holistic"]
    components = RankingComponents(
        skillMatch=state["skillMatch"],
        expRelevance=state["expRelevance"],
        holisticScore=holistic.holisticScore,
        yoeMatch=state["yoeMatch"],
    )
    final_score = round(
        components.skillMatch * w.skillMatch
        + components.expRelevance * w.expRelevance
        + components.holisticScore * w.holistic
        + components.yoeMatch * w.yoeMatch,
        4,
    )
    final_score = max(0.0, min(1.0, final_score))

    summary = _compose_summary(state, final_score)
    settings = state["settings"]
    model_version = (
        settings.model_version
        if state.get("holisticMethod") == "llm"
        else f"{settings.model_version}+offline_fallback"
    )

    ranking = CandidateRanking(
        candidateId=state["candidateId"],
        jobId=state["jobId"],
        finalScore=final_score,
        tier=_tier(final_score),  # type: ignore[arg-type]  # validated by Literal
        skillMatchPct=state["skillMatchPct"],
        expRelevanceScore=state["expRelevance"],
        components=components,
        strengths=holistic.strengths,
        concerns=holistic.concerns,
        interviewFocus=holistic.suggestedInterviewFocus,
        aiSummary=summary,
        biasCheck=holistic.biasCheck,
        confidence=holistic.confidence,
        scoredAt=datetime.now(timezone.utc).isoformat(),
        modelVersion=model_version,
        promptVersion=HOLISTIC_PROMPT_VERSION,
    )
    return {"ranking": ranking}


def _compose_summary(state: RankerState, final_score: float) -> str:
    holistic = state["holistic"]
    tier = _tier(final_score)
    lead = holistic.calibrationNote.strip()
    top_strength = holistic.strengths[0] if holistic.strengths else "No standout strengths surfaced."
    top_concern = holistic.concerns[0] if holistic.concerns else "No major concerns surfaced."
    return (
        f"Tier {tier} (score {final_score:.2f}). {lead} "
        f"Strength: {top_strength} Concern: {top_concern}"
    )


async def _node_bias_audit(state: RankerState) -> RankerState:
    """LangSmith: module1.ranker.bias_audit (spec step 6 audit log).

    Emits a structured audit record carrying the (already-stripped) CoT, the
    bias-check result, model + prompt version, and the masked-profile guarantee.
    In production the API persists this to the AuditLog table.
    """
    ranking = state["ranking"]
    log.info(
        "module1_scoring_decision",
        orgId=state["orgId"],
        jobId=state["jobId"],
        candidateId=state["candidateId"],
        finalScore=ranking.finalScore,
        tier=ranking.tier,
        confidence=ranking.confidence,
        biasIndicatorsDetected=ranking.biasCheck.biasIndicatorsDetected,
        correctionApplied=ranking.biasCheck.correctionApplied,
        modelVersion=ranking.modelVersion,
        promptVersion=ranking.promptVersion,
        # CoT reasoning stored for transparency/debugging — never returned to client.
        reasoningAudit=state.get("reasoningAudit", ""),
        biasMasked=True,
    )
    return {}


# ── Graph construction + public entry point ───────────────────────────────────
def _build_graph() -> Any:
    """Compile the LangGraph StateGraph (lazy import keeps offline import clean)."""
    from langgraph.graph import END, START, StateGraph

    graph = StateGraph(RankerState)
    graph.add_node("ensure_jd_structured", _node_ensure_jd_structured)
    graph.add_node("skill_match", _node_skill_match)
    graph.add_node("exp_relevance", _node_exp_relevance)
    graph.add_node("yoe", _node_yoe)
    graph.add_node("mask_profile", _node_mask_profile)
    graph.add_node("holistic_llm", _node_holistic_llm)
    graph.add_node("compose", _node_compose)
    graph.add_node("bias_audit", _node_bias_audit)

    graph.add_edge(START, "ensure_jd_structured")
    graph.add_edge("ensure_jd_structured", "skill_match")
    graph.add_edge("skill_match", "exp_relevance")
    graph.add_edge("exp_relevance", "yoe")
    graph.add_edge("yoe", "mask_profile")
    graph.add_edge("mask_profile", "holistic_llm")
    graph.add_edge("holistic_llm", "compose")
    graph.add_edge("compose", "bias_audit")
    graph.add_edge("bias_audit", END)
    return graph.compile()


# Compiled lazily and cached after first use.
_COMPILED: Any = None


async def _run(req: ScoreCandidateRequest, settings: Settings | None) -> RankerState:
    """Run the Module 1 ranking graph and return the final state.

    Falls back to a direct sequential run if LangGraph is not installed, so the
    pipeline is testable/offline without the dependency.
    """
    settings = settings or get_settings()
    weights = req.weights or RankingWeights()

    initial: RankerState = {
        "orgId": req.orgId,
        "jobId": req.jobId,
        "candidateId": req.candidateId,
        "profile": req.profile,
        "jdText": req.jdText,
        "weights": weights,
        "settings": settings,
        "orgContext": req.orgContext.model_dump() if req.orgContext is not None else None,
    }
    if req.jdStructured is not None:
        initial["jd"] = req.jdStructured

    # Only the graph BUILD can raise ImportError (langgraph missing). Isolate the
    # offline-degradation branch to build time so genuine node runtime errors during
    # ainvoke propagate instead of being silently swallowed into a sequential rerun.
    global _COMPILED
    if _COMPILED is None:
        try:
            _COMPILED = _build_graph()
        except ImportError:
            log.info("ranker_sequential_fallback")
            return await _run_sequential(initial)
    return await _COMPILED.ainvoke(initial)


async def score_candidate(
    req: ScoreCandidateRequest,
    *,
    settings: Settings | None = None,
) -> CandidateRanking:
    """Run the Module 1 ranking pipeline and return a CandidateRanking (CoT-free)."""
    final_state = await _run(req, settings)
    return final_state["ranking"]


async def score_candidate_with_reasoning(
    req: ScoreCandidateRequest,
    *,
    settings: Settings | None = None,
) -> tuple[CandidateRanking, str]:
    """Return the ranking AND the audit-only chain-of-thought reasoning.

    The HTTP layer emits ``reasoning`` as a sibling field over the internal
    server-to-server boundary so the API can persist it to ``candidate_rankings.
    reasoning``. It is NEVER returned to end clients (prompt standard #3).
    """
    final_state = await _run(req, settings)
    return final_state["ranking"], final_state.get("reasoningAudit", "")


async def score_batch(
    req: ScoreBatchRequest,
    *,
    settings: Settings | None = None,
) -> list[tuple[CandidateRanking, str]]:
    """Score a whole applicant batch against ONE job, parallelised (spec Module 1).

    Spec: candidate ranking is "parallelised across applicant batch" with a
    <8s/candidate latency target. We fan the candidates out with ``asyncio.gather``
    under an ``asyncio.Semaphore`` (size ``settings.batch_concurrency``, default 8)
    so the bounded concurrency holds the latency target without exhausting LLM/
    embedding connections or rate limits.

    Each candidate reuses the EXACT per-candidate path
    (``score_candidate_with_reasoning``) by building a ``ScoreCandidateRequest`` from
    the shared job fields (jdText/jdStructured/weights/orgContext) plus that
    candidate's id + profile. Results are returned in INPUT ORDER (the API sorts
    best-first); each item is ``(ranking, reasoning)`` where ``reasoning`` is the
    audit-only chain-of-thought (never returned to end clients — prompt standard #3).

    FAILURE ISOLATION: one candidate raising (validation/human-review/LLM error) must
    NOT sink the batch. We capture and log the error and OMIT that candidate from the
    results, so the recruiter still gets every candidate that scored cleanly.
    """
    settings = settings or get_settings()
    concurrency = max(1, settings.batch_concurrency)
    semaphore = asyncio.Semaphore(concurrency)

    async def _score_one(
        item: BatchCandidateInput,
    ) -> tuple[CandidateRanking, str] | None:
        single = ScoreCandidateRequest(
            orgId=req.orgId,
            jobId=req.jobId,
            candidateId=item.candidateId,
            profile=item.profile,
            jdText=req.jdText,
            jdStructured=req.jdStructured,
            weights=req.weights,
            orgContext=req.orgContext,
        )
        async with semaphore:
            try:
                return await score_candidate_with_reasoning(single, settings=settings)
            except Exception as exc:  # noqa: BLE001 — one failure must not sink the batch
                # Capture + log; this candidate is omitted from the batch result. The
                # API can re-score it individually (and will surface a RankSkip).
                log.warning(
                    "batch_candidate_failed",
                    orgId=req.orgId,
                    jobId=req.jobId,
                    candidateId=item.candidateId,
                    error=str(exc),
                )
                return None

    # return_exceptions=False is safe: _score_one never re-raises (it returns None on
    # failure), so gather resolves cleanly and preserves input order.
    settled = await asyncio.gather(*(_score_one(c) for c in req.candidates))
    return [r for r in settled if r is not None]


async def _run_sequential(state: RankerState) -> RankerState:
    """LangGraph-free sequential execution of the same nodes (dev fallback)."""
    for node in (
        _node_ensure_jd_structured,
        _node_skill_match,
        _node_exp_relevance,
        _node_yoe,
        _node_mask_profile,
        _node_holistic_llm,
        _node_compose,
        _node_bias_audit,
    ):
        update = await node(state)
        state.update(update)  # type: ignore[typeddict-item]
    return state
