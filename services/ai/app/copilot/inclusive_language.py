"""Inclusive-language pass for generated HR copy (spec 2a + prompt standard #4).

A deterministic, auditable lexicon scan that flags gendered, exclusionary, age,
ableist, and jargon phrasing in generated text and suggests an inclusive
alternative for each. Used by the JD writer to build an ``InclusiveLanguageReport``
(flagged phrases + a BiasCheck) on the assembled JD text.

This is INTENTIONALLY deterministic (no LLM): the JD writer prompt already instructs
the model to use inclusive language (standard #4), and this layer is the independent
verification + correction-tracking pass — exactly the "inclusive language check
(flag gendered words, exclusionary phrases -> suggest alternatives)" the spec calls
out for 2a. Keeping it rule-based means the bias report cannot itself be hallucinated
and is reproducible in the audit log.

STUB NOTE: the lexicon below covers the common cases the spec/standards name. In
production this would be backed by a maintained, org-tunable terminology service.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..schemas import BiasCheck, InclusiveFlag, InclusiveLanguageReport

InclusiveCategory = str  # one of the InclusiveCategory literals


@dataclass(frozen=True, slots=True)
class _LexEntry:
    """A flagged phrase pattern with its category and suggested alternative."""

    phrase: str  # human-readable phrase shown in the flag
    pattern: re.Pattern[str]  # word-boundary, case-insensitive matcher
    category: str  # GENDERED | EXCLUSIONARY | AGE | JARGON | ABLEIST | OTHER
    suggestion: str


def _entry(
    phrase: str,
    category: str,
    suggestion: str,
    *,
    not_followed_by: str | None = None,
) -> _LexEntry:
    # \b word boundaries so "guru" doesn't match inside another word; allow internal
    # whitespace runs to match across single spaces. ``not_followed_by`` adds a negative
    # lookahead so a benign collocation (e.g. "competitive salary") is NOT flagged while
    # the masculine-coded use (e.g. "competitive person") still is.
    escaped = re.escape(phrase).replace(r"\ ", r"\s+")
    lookahead = rf"(?!\s+(?:{not_followed_by}))" if not_followed_by else ""
    return _LexEntry(
        phrase=phrase,
        pattern=re.compile(rf"\b{escaped}\b{lookahead}", re.IGNORECASE),
        category=category,
        suggestion=suggestion,
    )


# Ordered lexicon. The standards (#4) explicitly call out masculine-coded words
# (competitive, dominant, rockstar, ninja) -> inclusive alternatives.
_LEXICON: tuple[_LexEntry, ...] = (
    # ── GENDERED / masculine-coded ──
    _entry("rockstar", "GENDERED", "skilled (e.g. 'skilled engineer')"),
    _entry("ninja", "GENDERED", "expert"),
    _entry("guru", "GENDERED", "specialist"),
    _entry("superhero", "GENDERED", "high performer"),
    _entry("dominant", "GENDERED", "leading"),
    _entry("aggressive", "GENDERED", "proactive"),
    # "competitive salary/pay/compensation/benefits/package/rate" is standard benign
    # benefits phrasing; only flag the behavioural/masculine-coded use.
    _entry(
        "competitive",
        "GENDERED",
        "motivated",
        not_followed_by="salary|salaries|pay|compensation|comp|benefits|package|rate|rates",
    ),
    _entry("he", "GENDERED", "they"),
    _entry("she", "GENDERED", "they"),
    _entry("his", "GENDERED", "their"),
    _entry("her", "GENDERED", "their"),
    _entry("manpower", "GENDERED", "workforce / staff"),
    _entry("chairman", "GENDERED", "chair / chairperson"),
    _entry("salesman", "GENDERED", "salesperson"),
    _entry("he/she", "GENDERED", "they"),
    # ── AGE ──
    _entry("young", "AGE", "energetic / motivated (avoid age framing)"),
    _entry("youthful", "AGE", "motivated"),
    _entry("digital native", "AGE", "comfortable with modern tools"),
    _entry("recent graduate", "AGE", "early-career (only if truly required)"),
    _entry("energetic", "AGE", "motivated"),
    _entry("mature", "AGE", "experienced"),
    # ── EXCLUSIONARY ──
    _entry("native english speaker", "EXCLUSIONARY", "fluent in English"),
    _entry("native speaker", "EXCLUSIONARY", "fluent"),
    _entry("culture fit", "EXCLUSIONARY", "values alignment / culture add"),
    _entry("brogrammer", "EXCLUSIONARY", "engineer"),
    _entry("blacklist", "EXCLUSIONARY", "blocklist / denylist"),
    _entry("whitelist", "EXCLUSIONARY", "allowlist"),
    # ── ABLEIST ──
    _entry("able-bodied", "ABLEIST", "(remove; describe the actual task requirement)"),
    _entry("crazy", "ABLEIST", "intense / fast-paced"),
    _entry("sanity check", "ABLEIST", "quick check / confidence check"),
    _entry("crippled", "ABLEIST", "degraded / impaired"),
    _entry("lame", "ABLEIST", "underwhelming"),
    _entry("stand-up meeting", "ABLEIST", "sync / check-in (if standing is not required)"),
    # ── JARGON ──
    _entry("synergy", "JARGON", "collaboration"),
    _entry("synergies", "JARGON", "ways to work together"),
    _entry("hit the ground running", "JARGON", "get started quickly"),
    _entry("wear many hats", "JARGON", "take on a variety of responsibilities"),
    _entry("work hard play hard", "JARGON", "(remove; describe real benefits)"),
    _entry("ninja-level", "JARGON", "expert-level"),
)


def scan_inclusive_language(text: str) -> list[InclusiveFlag]:
    """Scan ``text`` and return one ``InclusiveFlag`` per distinct flagged phrase.

    Deduplicated by (lowercased phrase, category): a word repeated across the JD is
    flagged once. Order follows the lexicon so the report is reproducible.
    """
    flags: list[InclusiveFlag] = []
    seen: set[tuple[str, str]] = set()
    for entry in _LEXICON:
        if entry.pattern.search(text):
            key = (entry.phrase.lower(), entry.category)
            if key in seen:
                continue
            seen.add(key)
            flags.append(
                InclusiveFlag(
                    phrase=entry.phrase,
                    category=entry.category,  # type: ignore[arg-type]  # validated by Literal
                    suggestion=entry.suggestion,
                )
            )
    return flags


def build_inclusive_report(text: str, *, correction_applied: bool = False) -> InclusiveLanguageReport:
    """Build the ``InclusiveLanguageReport`` for assembled JD text (spec 2a).

    ``biasCheck.biasIndicatorsDetected`` summarises the flagged categories so the
    audit log records what the inclusive-language pass caught; ``correctionApplied``
    reflects whether the caller rewrote the copy in response (the JD writer leaves the
    model copy intact and surfaces flags as suggestions, so it is False by default).
    """
    flags = scan_inclusive_language(text)
    categories = sorted({f.category for f in flags})
    indicators = [f"{cat.lower()}_language" for cat in categories]
    return InclusiveLanguageReport(
        flagged=flags,
        biasCheck=BiasCheck(
            biasIndicatorsDetected=indicators,
            correctionApplied=correction_applied,
        ),
    )
