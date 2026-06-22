"""Module 4 — RAG answer generation (spec Module 4 step 3 + step 5 escalation).

``answer_question`` takes a ``ChatAnswerRequest`` (query + history + candidateChunks +
employeeContext + orgContext; the API does retrieval and passes the top chunks) and returns
a ``ChatAnswerResponse`` grounded ONLY in those chunks.

Online path: the XML-tagged 7-standards prompt (app/prompts/hr_chat.py) + Pydantic
validation with the retry/human-review path (app/validation.py). On TOP of the prompt's
guards we apply two deterministic backstops that a privacy/faithfulness-critical surface
must never leave to the model alone:

  1. SENSITIVE-TOPIC backstop (step 5): a regex scan of the query for termination,
     harassment, salary dispute, and discrimination. A hit FORCES escalate=true +
     sensitiveTopic + intent ESCALATE even if the model didn't, so these never slip through.
  2. CITATION GROUNDING backstop (#2): every citation the model returns must reference a
     docId that was actually in the provided chunks; ungrounded citations are dropped. If
     the model claimed an answer but cited nothing AND no chunks were provided, we force a
     low-confidence escalation rather than trust an unsupported answer.

Offline path (no ANTHROPIC_API_KEY): a clearly-marked EXTRACTIVE fallback — stitch the top
chunks into a "here is what our policies say" answer with citations, set confidence "low",
and ALWAYS escalate (the deterministic path cannot judge sufficiency), so dev/CI works with
no network. modelVersion is then suffixed ``+offline_fallback``.
"""

from __future__ import annotations

import re

import structlog
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..llm import LLMRequest, LLMUnavailable, call_llm
from ..prompts.hr_chat import (
    PROMPT_VERSION,
    build_hr_chat_system_prompt,
    build_hr_chat_user_prompt,
)
from ..schemas import (
    BiasCheck,
    ChatAnswerRequest,
    ChatAnswerResponse,
    Citation,
    RetrievedChunk,
)
from ..validation import validate_or_review

log = structlog.get_logger(__name__)


class _ChatContent(BaseModel):
    """Internal validation model for the model's JSON.

    ``modelVersion`` / ``promptVersion`` are attached by this module, so this is a lean
    subset of ``ChatAnswerResponse``.
    """

    answer: str
    citations: list[Citation] = Field(default_factory=list)
    intent: str
    escalate: bool
    escalationReason: str | None = None
    sensitiveTopic: str | None = None
    confidence: str
    topic: str | None = None
    biasCheck: BiasCheck = Field(default_factory=BiasCheck)


# ── Sensitive-topic detection (spec step 5: forced human escalation) ──────────
# Conservative, word-boundary, case-insensitive patterns keyed to the canonical topic
# label surfaced in ``sensitiveTopic``. A match FORCES escalation regardless of context —
# these matters must reach a human (the model's own detection is a second line, not the
# only line).
_SENSITIVE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "termination",
        re.compile(
            r"\b(fired|terminat\w*|laid off|lay ?off|let go|wrongful dismissal|dismiss\w*|severance|resign(?:ation)?(?: under pressure)?)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "harassment",
        re.compile(
            r"\b(harass\w*|sexual\w* harass\w*|bully(?:ing|ied)?|inappropriate (?:comment|touch|behaviou?r)|hostile work\w* environment|unwanted advances)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "salary_dispute",
        re.compile(
            r"\b(underpaid|unpaid (?:wages|overtime)|pay dispute|salary dispute|wage (?:dispute|theft)|not (?:being )?paid (?:correctly|fairly)|owed (?:back ?pay|wages)|disagree with my pay)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "discrimination",
        re.compile(
            r"\b(discriminat\w*|retaliat\w*|racis\w*|sexis\w*|ageis\w*|treated unfairly because (?:of|i am)|denied .* because of my (?:race|gender|age|religion|disability))\b",
            re.IGNORECASE,
        ),
    ),
]


def detect_sensitive_topic(query: str) -> str | None:
    """Return the canonical sensitive-topic label if the query hits one, else None."""
    for topic, pattern in _SENSITIVE_PATTERNS:
        if pattern.search(query):
            return topic
    return None


def _ground_citations(
    citations: list[Citation], chunks: list[RetrievedChunk]
) -> list[Citation]:
    """Keep only citations whose docId was in the provided chunks, and REBUILD each from the
    matched chunk's AUTHORITATIVE metadata (faithfulness + contract-safety backstop).

    The model may name which docId/section it relied on, but docTitle + effectiveDate (and a
    validated sectionPath) are taken from the retrieved chunk — so a wrong title or an
    invented/non-ISO effectiveDate can never reach the client (the contract's
    Citation.effectiveDate is an ISO date or null). Duplicates are collapsed.
    """
    doc_meta: dict[str, RetrievedChunk] = {}
    sections: set[tuple[str, str]] = set()
    for ch in chunks:
        doc_meta.setdefault(ch.docId, ch)
        sections.add((ch.docId, ch.sectionPath))

    grounded: list[Citation] = []
    seen: set[tuple[str, str]] = set()
    for cit in citations:
        meta = doc_meta.get(cit.docId)
        if meta is None:
            log.warning("ungrounded_citation_dropped", docId=cit.docId)
            continue
        # Trust the model's sectionPath only if it matches a provided chunk's; else use the
        # matched chunk's. Title + effectiveDate ALWAYS come from the chunk, never the model.
        section = cit.sectionPath if (cit.docId, cit.sectionPath) in sections else meta.sectionPath
        key = (cit.docId, section)
        if key in seen:
            continue
        seen.add(key)
        grounded.append(
            Citation(
                docId=meta.docId,
                docTitle=meta.docTitle,
                sectionPath=section,
                effectiveDate=meta.effectiveDate,
            )
        )
    return grounded


def _apply_escalation_backstops(
    content: _ChatContent, req: ChatAnswerRequest
) -> _ChatContent:
    """Force escalation for sensitive topics, empty context, and ungrounded answers.

    These are deterministic guarantees layered on top of the prompt: a faithfulness- and
    safety-critical surface must not rely on the model alone to escalate.
    """
    # 1. Citations must reference provided chunks only.
    content.citations = _ground_citations(content.citations, req.candidateChunks)

    # 2. Sensitive topics ALWAYS escalate to a human (spec step 5).
    sensitive = detect_sensitive_topic(req.query)
    if sensitive:
        content.escalate = True
        content.intent = "ESCALATE"
        content.sensitiveTopic = content.sensitiveTopic or sensitive
        if not content.escalationReason:
            content.escalationReason = (
                f"Detected a sensitive topic ({sensitive.replace('_', ' ')}) that must be "
                "handled by a human HR Business Partner."
            )

    # 3. No retrieved context -> cannot ground an answer; escalate at low confidence.
    if not req.candidateChunks:
        content.escalate = True
        content.confidence = "low"
        if not content.escalationReason:
            content.escalationReason = (
                "No policy excerpts were available to ground an answer; routing to HR."
            )

    # 4. A policy answer that ended up with NO grounded citation cannot be trusted as
    #    grounded — escalate at low confidence (unless it was already an escalation, where a
    #    citationless supportive hand-off is expected).
    if not content.citations and not content.escalate and content.intent == "POLICY_QUESTION":
        content.escalate = True
        content.confidence = "low"
        content.escalationReason = (
            "The answer could not be grounded in a cited policy; routing to HR for "
            "confirmation."
        )
    return content


# ── Offline extractive fallback ───────────────────────────────────────────────
def _offline_content(req: ChatAnswerRequest) -> _ChatContent:
    """Deterministic extractive answer (clearly-marked stub).

    Stitches the top chunks into the answer with citations and ALWAYS escalates at low
    confidence (the heuristic cannot judge whether the chunks truly answer the question).
    Never invents policy: it only quotes provided chunk text. Sensitive topics are still
    detected and surfaced. Personalises lightly with the employee's own location.
    """
    sensitive = detect_sensitive_topic(req.query)
    top = req.candidateChunks[:3]

    if not top:
        answer = (
            "[OFFLINE DRAFT] I couldn't find any relevant policy excerpts for your question, "
            "so I don't want to guess. I'll connect you with an HR Business Partner who can "
            "help."
        )
        return _ChatContent(
            answer=answer,
            citations=[],
            intent="ESCALATE" if sensitive else "POLICY_QUESTION",
            escalate=True,
            escalationReason=(
                f"[offline] sensitive topic ({sensitive})" if sensitive
                else "[offline] no policy context available to ground an answer"
            ),
            sensitiveTopic=sensitive,
            confidence="low",
            topic=sensitive or "general_hr",
            biasCheck=BiasCheck(),
        )

    citations = [
        Citation(
            docId=c.docId,
            docTitle=c.docTitle,
            sectionPath=c.sectionPath,
            effectiveDate=c.effectiveDate,
        )
        for c in top
    ]
    excerpts = "\n\n".join(
        f"- From \"{c.docTitle}\" ({c.sectionPath}): {c.text.strip()[:400]}" for c in top
    )
    loc = req.employeeContext.location if req.employeeContext else None
    loc_note = (
        f" Your profile lists your location as {loc}; if our policy varies by region, "
        "confirm the part that applies to you with HR."
        if loc
        else ""
    )
    answer = (
        "[OFFLINE DRAFT] Here is what our current policies say that may relate to your "
        f"question:\n\n{excerpts}\n\nThis is a deterministic offline draft assembled "
        "directly from the policy excerpts (no language model). It may not fully answer "
        f"your question, so I'm flagging it for an HR Business Partner to confirm.{loc_note}"
    )
    return _ChatContent(
        answer=answer,
        citations=citations,
        intent="ESCALATE" if sensitive else "POLICY_QUESTION",
        escalate=True,  # offline path always escalates: it cannot judge sufficiency
        escalationReason=(
            f"[offline] sensitive topic ({sensitive}); routing to a human" if sensitive
            else "[offline] extractive draft only — human confirmation recommended"
        ),
        sensitiveTopic=sensitive,
        confidence="low",
        topic=sensitive or "general_hr",
        biasCheck=BiasCheck(),
    )


async def answer_question(
    req: ChatAnswerRequest, *, settings: Settings | None = None
) -> ChatAnswerResponse:
    """Generate a grounded RAG answer (spec Module 4 step 3) with escalation backstops."""
    settings = settings or get_settings()
    org_context = req.orgContext.model_dump() if req.orgContext is not None else None
    employee_context = (
        req.employeeContext.model_dump() if req.employeeContext is not None else None
    )

    system = build_hr_chat_system_prompt(org_context=org_context)
    user = build_hr_chat_user_prompt(
        query=req.query,
        history=[t.model_dump() for t in req.history],
        chunks=[c.model_dump() for c in req.candidateChunks],
        employee_context=employee_context,
    )

    method = "llm"

    async def _llm_call(prompt: str) -> str:
        return await call_llm(
            LLMRequest(
                system=system,
                user=prompt,
                max_tokens=1536,
                temperature=0.0,  # RAG faithfulness: grounded, not creative
                run_name="module4.hr_chat",
                tags=["module4", "hr_chat", "rag", PROMPT_VERSION],
            ),
            settings=settings,
        )

    try:
        content = await validate_or_review(
            _ChatContent,
            llm_call=_llm_call,
            user_prompt=user,
            ctx={"orgId": req.orgId, "query": req.query},
            module="module4",
            task="hr_chat",
        )
    except LLMUnavailable:
        log.info("hr_chat_offline_fallback", orgId=req.orgId)
        content = _offline_content(req)
        method = "offline_fallback"

    content = _apply_escalation_backstops(content, req)

    model_version = (
        settings.model_version
        if method == "llm"
        else f"{settings.model_version}+offline_fallback"
    )
    return ChatAnswerResponse(
        answer=content.answer,
        citations=content.citations,
        intent=content.intent,  # type: ignore[arg-type]
        escalate=content.escalate,
        escalationReason=content.escalationReason,
        sensitiveTopic=content.sensitiveTopic,
        confidence=content.confidence,  # type: ignore[arg-type]
        topic=content.topic,
        biasCheck=content.biasCheck,
        modelVersion=model_version,
        promptVersion=PROMPT_VERSION,
    )


__all__ = ["answer_question", "detect_sensitive_topic"]
