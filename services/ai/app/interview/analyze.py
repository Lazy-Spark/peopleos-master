"""Module 3 — Interview analysis (the 4 spec steps in one coherent LLM pass).

Takes an ``AnalyzeInterviewRequest`` (a diarised transcript + the role's scorecard
template + job title + optional org context) and returns an ``AnalyzeInterviewResponse``:

  step 1  competencyEvidence[]  — per detected Q/A: STAR per-dimension + completeness
  step 2  scorecardDraft        — one CompetencyScore (1-5) per template competency,
          EACH with a VERBATIM evidenceQuote (prompt standard #2: no score without
          evidence) + an overall recommendation/confidence/keyReasons
  step 3  scorecardDraft.summary — a 3-paragraph executive summary
  step 4  calibrationFlags[]    — LEADING_QUESTION + ILLEGAL_QUESTION grounded in a
          transcript quote (panel SCORE_DIVERGENCE is API-computed, not here)

The LLM call applies the 7 prompt-engineering standards (XML-tagged prompt with output
schema + >=2 few-shot in app/prompts/interview_analyze.py, Pydantic validation with the
retry/human-review path, a privacy guard, and a biasCheck on the HR-facing output).

PRIVACY (central to this module): the prompt forbids the model from repeating personal
disclosures the candidate volunteers (health/family/religion/etc.). On TOP of that
prompt-level guard, ``_enforce_evidence_guarantee`` validates structurally that every
competency carries a non-empty evidenceQuote, and the OFFLINE fallback never emits a
candidate's protected answer — it flags only the interviewer's off-limits QUESTION.

OFFLINE FALLBACK (no ANTHROPIC_API_KEY): a clearly-marked deterministic analysis built
from simple transcript heuristics (Q/A pairing by speaker role, keyword-based STAR and
competency signals, a regex scan for leading / illegal questions). modelVersion is then
suffixed with ``+offline_fallback``. This keeps the dev path (and the test suite) fully
runnable with no network and no GPU.
"""

from __future__ import annotations

import re

import structlog
from pydantic import BaseModel, Field, ValidationError

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.interview_analyze import (
    PROMPT_VERSION,
    build_analyze_system_prompt,
    build_analyze_user_prompt,
)
from ..schemas import (
    AiScorecardDraft,
    AnalyzeInterviewRequest,
    AnalyzeInterviewResponse,
    BiasCheck,
    CalibrationFlag,
    CompetencyEvidence,
    CompetencyScore,
    InterviewTranscript,
    ScorecardCompetency,
    StarScores,
    TranscriptSegment,
)
from ..validation import HumanReviewNeeded, validate_or_review

log = structlog.get_logger(__name__)


class _AnalysisContent(BaseModel):
    """Internal validation model for the model's JSON.

    ``modelVersion`` / ``promptVersion`` are attached by this module, so this is a lean
    subset of ``AnalyzeInterviewResponse``.
    """

    competencyEvidence: list[CompetencyEvidence] = Field(default_factory=list)
    scorecardDraft: AiScorecardDraft
    calibrationFlags: list[CalibrationFlag] = Field(default_factory=list)


# ── Offline heuristics ────────────────────────────────────────────────────────
# Off-limits topics (spec step 4 + privacy section) keyed to the IllegalTopic enum.
# Matched against INTERVIEWER turns only. Patterns are deliberately conservative
# (word-boundary, case-insensitive) so the offline heuristic flags the obvious cases
# the tests assert on; the LLM path catches the nuanced ones.
_ILLEGAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("PREGNANCY", re.compile(r"\b(pregnan\w*|expecting a baby|maternity)\b", re.IGNORECASE)),
    (
        "FAMILY_PLANNING",
        re.compile(
            r"\b(kids|children|childcare|plan(?:ning)? (?:to )?(?:have|start) a family|have a family)\b",
            re.IGNORECASE,
        ),
    ),
    ("RELIGION", re.compile(r"\b(religio\w*|church|mosque|synagogue|what faith|do you pray)\b", re.IGNORECASE)),
    ("AGE", re.compile(r"\b(how old are you|what(?:'s| is) your age|when were you born|too old|too young)\b", re.IGNORECASE)),
    ("NATIONALITY", re.compile(r"\b(where are you (?:really )?from|what(?:'s| is) your nationality|are you a citizen|country of origin)\b", re.IGNORECASE)),
    ("MARITAL_STATUS", re.compile(r"\b(are you married|marital status|do you have a (?:husband|wife|spouse)|are you single)\b", re.IGNORECASE)),
    ("HEALTH_DISABILITY", re.compile(r"\b(disabilit\w*|are you (?:disabled|healthy)|any (?:health|medical) (?:issues|conditions)|chronic (?:illness|condition))\b", re.IGNORECASE)),
    ("RACE", re.compile(r"\b(what(?:'s| is) your (?:race|ethnicity)|what(?:'s| is) your (?:racial )?background)\b", re.IGNORECASE)),
    ("SEXUAL_ORIENTATION", re.compile(r"\b(sexual orientation|are you (?:gay|straight|lesbian)|do you have a (?:boyfriend|girlfriend))\b", re.IGNORECASE)),
]

# Leading-question cues (interviewer steers the answer). Conservative phrasing.
_LEADING_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\byou(?:'d| would) agree\b", re.IGNORECASE),
    re.compile(r",?\s*(?:right|correct|don't you|wouldn't you|isn't it)\s*\??\s*$", re.IGNORECASE),
    re.compile(r"\bwouldn't you say\b", re.IGNORECASE),
    re.compile(r"\bsurely you\b", re.IGNORECASE),
    re.compile(r"\bI (?:assume|imagine) you\b", re.IGNORECASE),
    re.compile(r"\bdon't you think\b", re.IGNORECASE),
]

# STAR dimension keyword signals for the offline scorer (rough heuristic only).
_STAR_CUES: dict[str, re.Pattern[str]] = {
    "situation": re.compile(r"\b(at |when |we were|the situation|the problem|context|background)\b", re.IGNORECASE),
    "task": re.compile(r"\b(my (?:job|role|task)|I was responsible|I had to|goal|objective|needed to)\b", re.IGNORECASE),
    "action": re.compile(r"\b(I (?:built|did|led|wrote|designed|implemented|profiled|added|fixed|created|drove)|we (?:built|shipped|implemented))\b", re.IGNORECASE),
    "result": re.compile(r"\b(result|as a result|we (?:cut|reduced|increased|improved|grew)|p\d{2}|%|percent|latency|revenue|by \d)\b", re.IGNORECASE),
}

# Privacy guard (offline path). The candidate may volunteer personal disclosures
# (health/family/religion/etc.). The LLM path is governed by the prompt's privacy guard
# (standard #7); the OFFLINE path needs a structural one, because it quotes/summarises
# the candidate's own words. ``_redact_protected`` drops any sentence in candidate-derived
# text that mentions a protected topic, so such disclosures never reach the output.
_PROTECTED_TERMS = re.compile(
    r"\b("
    r"pregnan\w*|maternity|paternity|"
    r"kids|children|childcare|family planning|"
    r"religio\w*|church|mosque|synagogue|faith|"
    r"\d{1,2} years old|my age|"
    r"nationalit\w*|citizen|country of origin|"
    r"married|spouse|husband|wife|divorc\w*|"
    r"disabilit\w*|disabled|chronic (?:illness|condition)|medical condition|health (?:issue|condition)|"
    r"ethnicit\w*|\bracial\b|"
    r"gay|lesbian|straight|sexual orientation|boyfriend|girlfriend"
    r")\b",
    re.IGNORECASE,
)

# Split candidate text into sentences for selective redaction.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _redact_protected(text: str) -> str:
    """Drop sentences mentioning a protected topic from candidate-derived text.

    Used ONLY by the offline fallback (the LLM path obeys the prompt's privacy guard).
    Keeps the professional content; removes volunteered personal disclosures so they are
    never repeated in answerSummary / evidenceQuote / any output field. If every sentence
    is protected, returns a neutral placeholder rather than the raw text.
    """
    sentences = [s for s in _SENTENCE_SPLIT.split(text.strip()) if s.strip()]
    kept = [s for s in sentences if not _PROTECTED_TERMS.search(s)]
    if not kept:
        return "(answer content withheld — contained only personal disclosures)"
    return " ".join(kept).strip()


def transcript_to_text(transcript: InterviewTranscript) -> str:
    """Render a diarised transcript to plain ``Speaker: text`` lines for the prompt."""
    return "\n".join(f"{seg.speakerLabel}: {seg.text}".strip() for seg in transcript.segments)


def _interviewer_turns(transcript: InterviewTranscript) -> list[TranscriptSegment]:
    return [s for s in transcript.segments if s.speakerRole == "INTERVIEWER"]


def _detect_calibration_flags(transcript: InterviewTranscript) -> list[CalibrationFlag]:
    """Offline heuristic for step 4: scan INTERVIEWER turns for leading/illegal questions.

    Only the interviewer's QUESTION is ever quoted — never the candidate's answer
    (privacy guard). The richer detection is done by the LLM in the online path.
    """
    flags: list[CalibrationFlag] = []
    for seg in _interviewer_turns(transcript):
        text = seg.text.strip()
        if not text:
            continue
        for topic, pattern in _ILLEGAL_PATTERNS:
            if pattern.search(text):
                flags.append(
                    CalibrationFlag(
                        type="ILLEGAL_QUESTION",
                        severity="HIGH",
                        detail=(
                            "[OFFLINE HEURISTIC] The interviewer asked about an off-limits "
                            f"topic ({topic.replace('_', ' ').lower()}). This must not "
                            "influence the hiring decision; debrief the panel on lawful "
                            "interviewing."
                        ),
                        evidenceQuote=text,
                        illegalTopic=topic,  # type: ignore[arg-type]
                        competencyId=None,
                    )
                )
                break  # one illegal-topic flag per turn is enough
        for pattern in _LEADING_PATTERNS:
            if pattern.search(text):
                flags.append(
                    CalibrationFlag(
                        type="LEADING_QUESTION",
                        severity="MEDIUM",
                        detail=(
                            "[OFFLINE HEURISTIC] The question appears to steer the "
                            "candidate toward a particular answer, reducing its evidential "
                            "value. Prefer neutral, open phrasing."
                        ),
                        evidenceQuote=text,
                        illegalTopic=None,
                        competencyId=None,
                    )
                )
                break
    return flags


def _pair_qa(transcript: InterviewTranscript) -> list[tuple[str, str]]:
    """Pair each interviewer question with the immediately following candidate answer."""
    pairs: list[tuple[str, str]] = []
    pending_q: str | None = None
    for seg in transcript.segments:
        if seg.speakerRole == "INTERVIEWER" and seg.text.strip():
            pending_q = seg.text.strip()
        elif seg.speakerRole == "CANDIDATE" and seg.text.strip():
            q = pending_q or "(question not captured)"
            pairs.append((q, seg.text.strip()))
            pending_q = None
    return pairs


def _star_for(answer: str) -> StarScores:
    """Rough STAR scoring from keyword presence + answer length (offline only)."""
    length_factor = min(len(answer) / 280.0, 1.0)
    dims: dict[str, float] = {}
    for dim, pattern in _STAR_CUES.items():
        hit = 0.45 if pattern.search(answer) else 0.0
        dims[dim] = round(min(hit + 0.45 * length_factor, 1.0), 2)
    return StarScores(**dims)


def _competency_area(answer: str, competencies: list[ScorecardCompetency]) -> str:
    """Pick the template competency whose name/description best overlaps the answer."""
    low = answer.lower()
    best: tuple[int, str] = (0, competencies[0].name if competencies else "General")
    for c in competencies:
        terms = [c.name.lower(), *(c.description.lower().split() if c.description else [])]
        score = sum(1 for t in terms if t and t in low)
        if score > best[0]:
            best = (score, c.name)
    return best[1]


def _score_from_star(star: StarScores) -> int:
    """Map mean STAR completeness to a 1-5 score (offline heuristic)."""
    mean = (star.situation + star.task + star.action + star.result) / 4.0
    if mean >= 0.85:
        return 5
    if mean >= 0.65:
        return 4
    if mean >= 0.45:
        return 3
    if mean >= 0.25:
        return 2
    return 1


def _offline_content(req: AnalyzeInterviewRequest) -> _AnalysisContent:
    """Deterministic offline analysis (clearly-marked stub).

    Never repeats the candidate's protected disclosures (it only summarises the answer
    abstractly and only quotes the answer text the model would have evidence for). Every
    competency receives a non-empty evidenceQuote (prompt standard #2 / DB constraint).
    """
    transcript = req.transcript
    competencies = list(req.scorecardTemplate.competencies)
    qa_pairs = _pair_qa(transcript)

    # Privacy guard: redact volunteered personal disclosures from the candidate's words
    # BEFORE they reach any output field (offline path). The STAR/competency scoring runs
    # on the ORIGINAL answer (it never surfaces the text), but everything we emit
    # (answerSummary / evidenceQuote) uses the redacted form.
    redacted_qa: list[tuple[str, str, str]] = [
        (question, answer, _redact_protected(answer)) for question, answer in qa_pairs
    ]

    evidence: list[CompetencyEvidence] = []
    for question, answer, safe_answer in redacted_qa:
        star = _star_for(answer)
        area = _competency_area(answer, competencies)
        evidence.append(
            CompetencyEvidence(
                question=question,
                answerSummary="[OFFLINE] " + (safe_answer[:160] + ("…" if len(safe_answer) > 160 else "")),
                behaviouralIndicators=[],
                competencyArea=area,
                star=star,
                starCompleteness=round(
                    (star.situation + star.task + star.action + star.result) / 4.0, 2
                ),
            )
        )

    # Best available candidate quote to attach as evidence per competency. We use the
    # longest REDACTED candidate answer as a generic fallback so the evidenceQuote is
    # NEVER empty and never repeats a protected disclosure.
    safe_answers = [safe for _, _, safe in redacted_qa]
    fallback_quote = (
        max(safe_answers, key=len)
        if safe_answers
        else "(no candidate answer captured in transcript)"
    )

    competency_scores: list[CompetencyScore] = []
    for c in competencies:
        # Find an answer whose extracted competencyArea matches this competency.
        match_quote = fallback_quote
        match_star: StarScores | None = None
        for ev, (_, _ans, safe) in zip(evidence, redacted_qa, strict=True):
            if ev.competencyArea == c.name:
                match_quote = safe
                match_star = ev.star
                break
        score = _score_from_star(match_star) if match_star else 1
        competency_scores.append(
            CompetencyScore(
                competencyId=c.competencyId,
                competencyName=c.name,
                score=score,
                evidenceQuote=match_quote[:240],
                rationale=(
                    "[OFFLINE HEURISTIC] Score derived from a keyword-based STAR estimate "
                    "of the matched answer; a human reviewer should confirm against the "
                    "full transcript."
                ),
            )
        )

    # Overall recommendation from the mean competency score.
    if competency_scores:
        mean_score = sum(cs.score for cs in competency_scores) / len(competency_scores)
    else:
        mean_score = 0.0
    if mean_score >= 4.25:
        recommendation = "STRONG_YES"
    elif mean_score >= 3.25:
        recommendation = "YES"
    elif mean_score >= 2.0:
        recommendation = "NO"
    else:
        recommendation = "STRONG_NO"

    job = req.jobTitle or "the role"
    summary = (
        f"[OFFLINE DRAFT] The candidate interviewed for {job}. This is a deterministic "
        "offline summary generated without the language model.\n\n"
        f"Across {len(qa_pairs)} captured question/answer exchange(s), the heuristic "
        f"scored {len(competency_scores)} template competenc(y/ies) with a mean of "
        f"{mean_score:.1f}/5 based on STAR keyword signals.\n\n"
        "Treat this as a placeholder only: run the language-model analysis (set "
        "ANTHROPIC_API_KEY) for evidence-grounded scoring, and have a human reviewer "
        "confirm every score against the full transcript before any decision."
    )

    draft = AiScorecardDraft(
        competencyScores=competency_scores,
        overallRecommendation=recommendation,  # type: ignore[arg-type]
        confidence="low",  # offline heuristic is never high-confidence
        keyReasons=[
            "[OFFLINE HEURISTIC] keyword-based STAR estimate; not model-graded",
            "human review required before any hiring decision",
        ],
        summary=summary,
        biasCheck=BiasCheck(biasIndicatorsDetected=[], correctionApplied=False),
    )

    flags = _detect_calibration_flags(transcript)
    return _AnalysisContent(
        competencyEvidence=evidence, scorecardDraft=draft, calibrationFlags=flags
    )


def _enforce_evidence_guarantee(
    content: _AnalysisContent, transcript: InterviewTranscript
) -> _AnalysisContent:
    """Backstop prompt standard #2: every competency score MUST have an evidenceQuote.

    If the model returns an empty quote we substitute the longest candidate utterance
    (or a clear placeholder) rather than persisting a score with no evidence. We do NOT
    silently drop the score — the rationale is annotated so a reviewer sees the gap. The
    back-fill quote is redacted (privacy guard) so a back-filled quote never reintroduces
    a protected disclosure.
    """
    candidate_answers = [
        _redact_protected(s.text.strip())
        for s in transcript.segments
        if s.speakerRole == "CANDIDATE" and s.text.strip()
    ]
    fallback = max(candidate_answers, key=len) if candidate_answers else "(no candidate utterance captured)"
    repaired: list[CompetencyScore] = []
    for cs in content.scorecardDraft.competencyScores:
        quote = (cs.evidenceQuote or "").strip()
        if quote:
            # Defence-in-depth PARITY with the offline path: redact protected
            # disclosures from a MODEL-supplied quote too. The prompt instructs the
            # model to omit them, but a privacy guarantee must never rest on the model.
            safe = _redact_protected(quote)[:240]
            repaired.append(cs if safe == quote else cs.model_copy(update={"evidenceQuote": safe}))
            continue
        log.warning("evidence_quote_missing_repaired", competencyId=cs.competencyId)
        repaired.append(
            cs.model_copy(
                update={
                    "evidenceQuote": fallback[:240],
                    "rationale": (cs.rationale + " [evidence quote was missing and "
                                  "back-filled from the transcript; verify manually]"),
                }
            )
        )
    content.scorecardDraft = content.scorecardDraft.model_copy(
        update={"competencyScores": repaired}
    )
    return content


async def analyze_interview(
    req: AnalyzeInterviewRequest,
    *,
    settings: Settings | None = None,
) -> AnalyzeInterviewResponse:
    """Run the 4-step interview analysis (spec Module 3 AI analysis)."""
    settings = settings or get_settings()
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None
    competencies_json = [c.model_dump() for c in req.scorecardTemplate.competencies]

    system = build_analyze_system_prompt(job_title=req.jobTitle, org_context=org_context)
    user = build_analyze_user_prompt(
        job_title=req.jobTitle,
        competencies=competencies_json,
        transcript_text=transcript_to_text(req.transcript),
    )

    method = "llm"

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=4096,  # multi-step structured output over a transcript
                temperature=0.0,  # evidence extraction must be faithful, not creative
                run_name="module3.interview_analyze",
                tags=["module3", "interview", "analyze", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _AnalysisContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "interviewId": req.interviewId},
            module="module3",
            task="interview_analyze",
        )
    except LLMUnavailable:
        log.info("interview_analyze_offline_fallback", orgId=req.orgId, interviewId=req.interviewId)
        content = _offline_content(req)
        method = "offline_fallback"

    content = _enforce_evidence_guarantee(content, req.transcript)

    model_version = (
        settings.model_version if method == "llm" else f"{settings.model_version}+offline_fallback"
    )
    return AnalyzeInterviewResponse(
        scorecardDraft=content.scorecardDraft,
        competencyEvidence=content.competencyEvidence,
        calibrationFlags=content.calibrationFlags,
        modelVersion=model_version,
        promptVersion=PROMPT_VERSION,
    )


# Re-export for the API exception handler symmetry / tests.
__all__ = ["HumanReviewNeeded", "ValidationError", "analyze_interview", "transcript_to_text"]
