"""Resume parse pipeline (spec Layer 2A).

Pipeline (spec steps):
  1. Format detection + extraction
       - text/plain or ``rawText``  -> direct ingest (always works offline)
       - application/pdf            -> pdfplumber (guarded import; degrade to warning)
       - DOCX                       -> python-docx (guarded import; degrade to warning)
     The ``fileUrl`` path is fetched with httpx; ``rawText`` runs fully offline.
  2. Structured entity extraction
       - spaCy NER if available (guarded import); otherwise a CLEARLY-MARKED
         deterministic heuristic/regex fallback so the service runs offline in dev.
  3. Skill normalisation  (canonicalise aliases, e.g. "React.js" -> "React")
  4. Experience gap detection (>3 months) + total YoE
  5. CandidateProfile construction -> ParseResumeResponse

The pipeline never calls an LLM for parsing in this offline slice; the heavy NER
model is the production path. Everything here is deterministic and testable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timezone

import structlog

from ..config import Settings, get_settings
from ..schemas import (
    CandidateProfile,
    CandidateSkill,
    Education,
    ExperienceGap,
    ParseResumeRequest,
    ParseResumeResponse,
    WorkExperience,
)
from ..scoring.synonyms import canonical_skill

log = structlog.get_logger(__name__)

# Spec step 4: gaps > 3 months in employment history are flagged.
_GAP_THRESHOLD_MONTHS = 3.0
_DAYS_PER_MONTH = 30.4375  # average; used only for gap/overlap month maths

# ── Regexes for the heuristic entity-extraction fallback ──────────────────────
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"(?:(?:\+?\d{1,3}[\s.\-]?)?(?:\(?\d{2,4}\)?[\s.\-]?){2,4}\d{2,4})")
_LINKEDIN_RE = re.compile(r"https?://(?:[a-z]{2,3}\.)?linkedin\.com/[^\s)>\]]+", re.IGNORECASE)
_GITHUB_RE = re.compile(r"https?://(?:www\.)?github\.com/[^\s)>\]]+", re.IGNORECASE)

# A "Skills:" line lists comma/semicolon/pipe-separated skills.
_SKILLS_LINE_RE = re.compile(r"^\s*(?:technical\s+)?skills?\s*[:\-]\s*(.+)$", re.IGNORECASE)
_SKILL_SPLIT_RE = re.compile(r"[,;|/]| and ")

# A work-experience header like "Senior Engineer at Acme (2019-01 - 2022-06)".
_EXPERIENCE_RE = re.compile(
    r"^\s*(?P<title>[A-Z][\w ./&\-]+?)\s+(?:at|@|,)\s+(?P<company>[\w ./&'\-]+?)\s*"
    r"\(?(?P<start>\d{4}(?:-\d{2})?)\s*(?:[-–—to]+)\s*(?P<end>\d{4}(?:-\d{2})?|present|current)\)?",
    re.IGNORECASE,
)

# An education header like "BSc Computer Science, MIT (2014-2018)".
_EDUCATION_RE = re.compile(
    r"^\s*(?P<degree>[A-Za-z.]+(?:\s[A-Za-z.]+)?)\s+(?P<field>[\w ./&\-]+?),?\s+"
    r"(?P<school>[\w ./&'\-]+?)\s*\(?(?P<start>\d{4})?\s*(?:[-–—to]*)\s*(?P<end>\d{4})?\)?\s*$"
)

_EDUCATION_KEYWORDS = ("university", "college", "institute", "school", "bsc", "msc", "phd", "b.a", "m.a", "b.s", "m.s")


@dataclass(slots=True)
class _ExtractedText:
    text: str
    warnings: list[str]


# ── Step 1: format detection + extraction ────────────────────────────────────
async def _extract_text(req: ParseResumeRequest, settings: Settings) -> _ExtractedText:
    """Get plain text from the request (rawText | fileUrl). Heavy parsers guarded."""
    warnings: list[str] = []

    if req.rawText is not None:
        return _ExtractedText(text=req.rawText, warnings=warnings)

    # fileUrl path: fetch bytes, then parse by mime type.
    assert req.fileUrl is not None  # validated by the model
    try:
        import httpx

        async with httpx.AsyncClient(timeout=settings.llm_timeout_seconds) as client:
            resp = await client.get(req.fileUrl)
            resp.raise_for_status()
            data = resp.content
    except Exception as exc:  # noqa: BLE001 — network/transport failures degrade to a warning
        log.warning("resume_fetch_failed", error=str(exc))
        warnings.append(f"Could not fetch fileUrl: {exc}")
        return _ExtractedText(text="", warnings=warnings)

    mime = req.mimeType or "application/pdf"
    if mime == "text/plain":
        return _ExtractedText(text=data.decode("utf-8", errors="replace"), warnings=warnings)

    if mime == "application/pdf":
        text = _extract_pdf(data, warnings)
        return _ExtractedText(text=text, warnings=warnings)

    # DOCX
    text = _extract_docx(data, warnings)
    return _ExtractedText(text=text, warnings=warnings)


def _extract_pdf(data: bytes, warnings: list[str]) -> str:
    try:
        import io

        import pdfplumber  # heavy/optional — guarded
    except ImportError:
        warnings.append("pdfplumber not installed; install the 'parsers' extra to parse PDFs.")
        return ""
    try:
        parts: list[str] = []
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages:
                parts.append(page.extract_text() or "")
        return "\n".join(parts)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"PDF extraction failed: {exc}")
        return ""


def _extract_docx(data: bytes, warnings: list[str]) -> str:
    try:
        import io

        import docx  # python-docx — guarded
    except ImportError:
        warnings.append("python-docx not installed; install the 'parsers' extra to parse DOCX.")
        return ""
    try:
        document = docx.Document(io.BytesIO(data))
        return "\n".join(p.text for p in document.paragraphs)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"DOCX extraction failed: {exc}")
        return ""


# ── Step 2: entity extraction (spaCy if available else heuristic fallback) ────
def _spacy_available() -> bool:
    try:
        import spacy  # noqa: F401
    except ImportError:
        return False
    return True


def _extract_name(text: str, warnings: list[str]) -> str | None:
    """Best-effort candidate name.

    Uses spaCy PERSON entities when available; otherwise the HEURISTIC FALLBACK
    treats the first non-empty line (if it is short and not contact info) as the name.
    """
    if _spacy_available():
        try:
            import spacy

            # en_core_web_sm may not be downloaded; guard the load too.
            nlp = spacy.blank("en") if not spacy.util.is_package("en_core_web_sm") else spacy.load("en_core_web_sm")
            if "ner" in nlp.pipe_names:
                doc = nlp(text[:1000])
                for ent in doc.ents:
                    if ent.label_ == "PERSON":
                        return ent.text.strip()
        except Exception as exc:  # noqa: BLE001 — fall through to heuristic
            warnings.append(f"spaCy NER unavailable, used heuristic name extraction: {exc}")

    # HEURISTIC FALLBACK (clearly marked): first plausible line.
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if _EMAIL_RE.search(stripped) or _PHONE_RE.fullmatch(stripped):
            continue
        words = stripped.split()
        if 1 < len(words) <= 4 and all(w[:1].isupper() for w in words if w[:1].isalpha()):
            return stripped
        break
    return None


def _first(pattern: re.Pattern[str], text: str) -> str | None:
    m = pattern.search(text)
    return m.group(0).strip() if m else None


def _extract_skills(text: str) -> list[str]:
    """Collect raw skill strings from any 'Skills:' line(s)."""
    raw: list[str] = []
    for line in text.splitlines():
        m = _SKILLS_LINE_RE.match(line)
        if m:
            for token in _SKILL_SPLIT_RE.split(m.group(1)):
                token = token.strip().strip(".")
                if token:
                    raw.append(token)
    return raw


def _extract_experiences(text: str) -> list[WorkExperience]:
    out: list[WorkExperience] = []
    for line in text.splitlines():
        m = _EXPERIENCE_RE.match(line)
        if not m:
            continue
        end_raw = m.group("end")
        is_current = end_raw.lower() in {"present", "current"}
        out.append(
            WorkExperience(
                company=m.group("company").strip(),
                title=m.group("title").strip(),
                startDate=_normalise_iso(m.group("start")),
                endDate=None if is_current else _normalise_iso(end_raw),
                description=None,
                isCurrent=is_current,
            )
        )
    return out


def _extract_education(text: str) -> list[Education]:
    out: list[Education] = []
    for line in text.splitlines():
        lower = line.lower()
        if not any(k in lower for k in _EDUCATION_KEYWORDS):
            continue
        m = _EDUCATION_RE.match(line)
        if not m:
            continue
        out.append(
            Education(
                school=m.group("school").strip(),
                degree=(m.group("degree") or "").strip() or None,
                field=(m.group("field") or "").strip() or None,
                startYear=int(m.group("start")) if m.group("start") else None,
                endYear=int(m.group("end")) if m.group("end") else None,
            )
        )
    return out


def _normalise_iso(raw: str | None) -> str | None:
    """Coerce 'YYYY' or 'YYYY-MM' into an IsoDate (YYYY-MM-DD)."""
    if not raw:
        return None
    raw = raw.strip()
    if re.fullmatch(r"\d{4}", raw):
        return f"{raw}-01-01"
    if re.fullmatch(r"\d{4}-\d{2}", raw):
        return f"{raw}-01"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return raw
    return None


# ── Step 3: skill normalisation ───────────────────────────────────────────────
def _normalise_skills(raw_skills: list[str]) -> list[CandidateSkill]:
    seen: set[str] = set()
    out: list[CandidateSkill] = []
    for raw in raw_skills:
        canon = canonical_skill(raw)
        key = canon.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(
            CandidateSkill(
                canonicalName=canon,
                rawName=raw if raw != canon else None,
                # Default taxonomy bucket; a real ESCO lookup classifies precisely.
                category="TECHNICAL",
                proficiency=None,
                confidence=0.6,  # spec Layer 3A: resume-inferred skills = 0.6
            )
        )
    return out


# ── Step 4: gap detection (>3 months) + total YoE ─────────────────────────────
def _parse_iso_date(iso: str | None) -> date | None:
    if not iso:
        return None
    try:
        return datetime.strptime(iso, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _detect_gaps_and_yoe(
    experiences: list[WorkExperience], today: date
) -> tuple[list[ExperienceGap], float | None]:
    """Detect employment gaps (>3 months) / overlaps and compute total YoE.

    Total YoE is the union of employed time across all experiences (no double
    counting of overlapping roles), expressed in years.
    """
    intervals: list[tuple[date, date]] = []
    for exp in experiences:
        start = _parse_iso_date(exp.startDate)
        if start is None:
            continue
        end = today if (exp.isCurrent or exp.endDate is None) else _parse_iso_date(exp.endDate)
        if end is None or end < start:
            end = today if exp.isCurrent else start
        intervals.append((start, end))

    if not intervals:
        return [], None

    intervals.sort(key=lambda iv: iv[0])

    gaps: list[ExperienceGap] = []
    # Overlap + gap detection over consecutive (by start) intervals.
    for prev, curr in zip(intervals, intervals[1:], strict=False):
        prev_end = prev[1]
        curr_start = curr[0]
        delta_days = (curr_start - prev_end).days
        months = round(abs(delta_days) / _DAYS_PER_MONTH, 1)
        if delta_days > 0 and months > _GAP_THRESHOLD_MONTHS:
            gaps.append(
                ExperienceGap(
                    type="GAP",
                    fromDate=prev_end.isoformat(),
                    toDate=curr_start.isoformat(),
                    months=months,
                )
            )
        elif delta_days < 0:  # curr started before prev ended -> overlap
            gaps.append(
                ExperienceGap(
                    type="OVERLAP",
                    fromDate=curr_start.isoformat(),
                    toDate=prev_end.isoformat(),
                    months=months,
                )
            )

    # Total YoE = union of employed days / 365.25.
    merged: list[list[date]] = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    total_days = sum((iv[1] - iv[0]).days for iv in merged)
    total_yoe = round(total_days / 365.25, 2) if total_days > 0 else 0.0

    return gaps, total_yoe


# ── Step 5: profile construction / public entry point ─────────────────────────
async def parse_resume(
    req: ParseResumeRequest,
    *,
    settings: Settings | None = None,
    today: date | None = None,
) -> ParseResumeResponse:
    """Run the full resume pipeline and return a ParseResumeResponse."""
    settings = settings or get_settings()
    today = today or date.today()

    extracted = await _extract_text(req, settings)
    warnings = list(extracted.warnings)
    text = extracted.text

    if not text.strip():
        warnings.append("No text could be extracted from the resume; profile is empty.")

    method = "spacy_ner" if _spacy_available() else "heuristic_fallback"
    if method == "heuristic_fallback":
        warnings.append("Entity extraction used the deterministic heuristic fallback (spaCy not installed).")

    name = _extract_name(text, warnings)
    email = _first(_EMAIL_RE, text)
    phone = _first(_PHONE_RE, text)
    linkedin = _first(_LINKEDIN_RE, text)
    github = _first(_GITHUB_RE, text)

    experiences = _extract_experiences(text)
    education = _extract_education(text)
    skills = _normalise_skills(_extract_skills(text))
    gaps, total_yoe = _detect_gaps_and_yoe(experiences, today)

    profile = CandidateProfile(
        name=name,
        # EmailStr would reject a malformed match; only set when it validates.
        email=email if email and _EMAIL_RE.fullmatch(email) else None,
        phone=phone,
        linkedinUrl=linkedin,
        githubUrl=github,
        location=None,
        education=education,
        experience=experiences,
        skills=skills,
        certifications=[],
        languages=[],
        publications=[],
        gaps=gaps,
        totalYoe=total_yoe,
    )

    return ParseResumeResponse(
        profile=profile,
        warnings=warnings,
        modelVersion=f"resume_parse@{method}",
        parsedAt=datetime.now(timezone.utc).isoformat(),
    )
