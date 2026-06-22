"""Module 5e — safe navigation, formatting, and rule-based analytics over the snapshot.

The ``DashboardMetrics`` snapshot arrives at the AI service as an opaque dict (the API has
already validated it against the strict Zod contract). These helpers let the offline
fallbacks read it without ever raising on a missing/null field, format values for humans,
detect rule-based anomalies (the deterministic counterpart of the LLM's anomaly pass), and
do a keyword -> metric lookup for "Ask your data".

Pure functions, NO LLM, NO network — used by both ``narrative.py`` and ``ask.py``.
"""

from __future__ import annotations

from ..schemas import Anomaly, ChartPoint, ChartSpec, FlagSeverity

# ── Thresholds (spec Module 5b + 5e) ─────────────────────────────────────────────
# Span of control: WIDE > 8 reports, NARROW < 3 (the Zod SpanFlag is already computed in
# the API; we read its `flag`). Stage conversion below this is a funnel concern (5e).
LOW_CONVERSION = 0.30
# A healthy offer-acceptance bar; below this is a recruiting soft spot.
LOW_OFFER_ACCEPTANCE = 0.70
# New-hire success (90-day mark with good perf) below this warrants a selection-quality look.
LOW_NEW_HIRE_SUCCESS = 0.70


def get_path(data: object, path: str) -> object:
    """Safely read a dotted ``path`` (e.g. "recruiting.openRoles") from a nested dict.

    Returns None if any segment is missing or a non-dict is encountered. Never raises.
    """
    cur: object = data
    for segment in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(segment)
        if cur is None:
            return None
    return cur


def _as_float(value: object) -> float | None:
    """Coerce a numeric-ish value to float, else None (never raises)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def fmt_count(value: object) -> str:
    """Format an integer-ish count (e.g. 12)."""
    f = _as_float(value)
    if f is None:
        return "n/a"
    return str(int(f))


def fmt_days(value: object) -> str:
    """Format a day count (e.g. "61 days"); rounds to a whole day."""
    f = _as_float(value)
    if f is None:
        return "n/a"
    return f"{round(f)} days"


def fmt_pct(value: object) -> str:
    """Format a 0..1 UnitScore as a percent (e.g. 0.58 -> "58%")."""
    f = _as_float(value)
    if f is None:
        return "n/a"
    return f"{round(f * 100)}%"


# ── Rule-based anomaly detection (offline counterpart of the LLM anomaly pass) ────
def detect_anomalies(metrics: dict[str, object]) -> list[Anomaly]:
    """Deterministic anomalies from the snapshot (span flags, SLA, conversion, etc.).

    Mirrors the spec's anomaly examples (5e): WIDE/NARROW span of control, SLA breaches,
    low stage conversion (< ~0.3), low offer-acceptance, low new-hire success, and
    promotion bottlenecks. Severities match the prompt's guidance so online + offline
    outputs are consistent.
    """
    out: list[Anomaly] = []

    # SLA breaches — HIGH (clear, urgent).
    breaches = get_path(metrics, "recruiting.slaBreaches")
    if isinstance(breaches, list) and breaches:
        detail = ", ".join(
            f"{b.get('title', 'role')} ({b.get('daysOpen', '?')}d)"
            for b in breaches[:5]
            if isinstance(b, dict)
        )
        out.append(
            Anomaly(
                metric="recruiting.slaBreaches",
                detail=f"{len(breaches)} role(s) open past SLA: {detail}.",
                severity="HIGH",
            )
        )

    # Span of control — WIDE (MEDIUM) / NARROW (LOW). The flag is precomputed in the API.
    spans = get_path(metrics, "workforce.spanOfControl")
    if isinstance(spans, list):
        wide = [s for s in spans if isinstance(s, dict) and s.get("flag") == "WIDE"]
        narrow = [s for s in spans if isinstance(s, dict) and s.get("flag") == "NARROW"]
        if wide:
            names = ", ".join(
                f"{s.get('managerName') or s.get('managerId')} ({s.get('directReports')})"
                for s in wide[:5]
            )
            out.append(
                Anomaly(
                    metric="workforce.spanOfControl",
                    detail=f"{len(wide)} manager(s) with a WIDE span (>8 reports): {names}.",
                    severity="MEDIUM",
                )
            )
        if narrow:
            names = ", ".join(
                f"{s.get('managerName') or s.get('managerId')} ({s.get('directReports')})"
                for s in narrow[:5]
            )
            out.append(
                Anomaly(
                    metric="workforce.spanOfControl",
                    detail=f"{len(narrow)} manager(s) with a NARROW span (<3 reports): {names}.",
                    severity="LOW",
                )
            )

    # Low stage conversion (< ~0.3) — MEDIUM.
    conversions = get_path(metrics, "recruiting.conversionRates")
    if isinstance(conversions, list):
        for c in conversions:
            if not isinstance(c, dict):
                continue
            rate = _as_float(c.get("rate"))
            if rate is not None and rate < LOW_CONVERSION:
                out.append(
                    Anomaly(
                        metric="recruiting.conversionRates",
                        detail=(
                            f"{c.get('from')}→{c.get('to')} conversion is "
                            f"{fmt_pct(rate)}, below ~{int(LOW_CONVERSION * 100)}%."
                        ),
                        severity="MEDIUM",
                    )
                )

    # Low offer-acceptance — MEDIUM.
    oar = _as_float(get_path(metrics, "recruiting.offerAcceptanceRate"))
    if oar is not None and oar < LOW_OFFER_ACCEPTANCE:
        out.append(
            Anomaly(
                metric="recruiting.offerAcceptanceRate",
                detail=(
                    f"Offer-acceptance rate is {fmt_pct(oar)}, below a healthy "
                    f"~{int(LOW_OFFER_ACCEPTANCE * 100)}% bar."
                ),
                severity="MEDIUM",
            )
        )

    # Low new-hire success — MEDIUM.
    nhs = _as_float(get_path(metrics, "workforce.newHireSuccessRate"))
    if nhs is not None and nhs < LOW_NEW_HIRE_SUCCESS:
        out.append(
            Anomaly(
                metric="workforce.newHireSuccessRate",
                detail=(
                    f"New-hire success is {fmt_pct(nhs)} at the 90-day mark, below "
                    f"~{int(LOW_NEW_HIRE_SUCCESS * 100)}%."
                ),
                severity="MEDIUM",
            )
        )

    # Promotion bottleneck: a level with a non-trivial cohort but a 0% promotion rate.
    promos = get_path(metrics, "workforce.promotionRateByLevel")
    if isinstance(promos, list):
        for p in promos:
            if not isinstance(p, dict):
                continue
            rate = _as_float(p.get("rate"))
            total = _as_float(p.get("total"))
            if rate is not None and rate == 0.0 and total is not None and total >= 5:
                out.append(
                    Anomaly(
                        metric="workforce.promotionRateByLevel",
                        detail=(
                            f"0% promotion rate at {p.get('level')} "
                            f"(0 of {int(total)}) — progression bottleneck."
                        ),
                        severity="MEDIUM",
                    )
                )

    return out


# ── Keyword -> metric lookup for the "Ask your data" offline fallback ─────────────
def _bucket_chart(value: object, title: str) -> ChartSpec | None:
    """Build a BAR ChartSpec from a list of {key, count} headcount buckets."""
    if not isinstance(value, list) or not value:
        return None
    series: list[ChartPoint] = []
    for b in value:
        if isinstance(b, dict) and b.get("key") is not None:
            count = _as_float(b.get("count"))
            if count is not None:
                series.append(ChartPoint(label=str(b.get("key")), value=count))
    if not series:
        return None
    return ChartSpec(type="BAR", title=title, series=series)


def _bucket_answer(value: object, noun: str) -> str:
    """Templated answer naming each bucket and its count."""
    parts = [
        f"{b.get('key')}: {fmt_count(b.get('count'))}"
        for b in value  # type: ignore[union-attr]
        if isinstance(b, dict) and b.get("key") is not None
    ]
    return f"Headcount by {noun} — " + "; ".join(parts) + "."


# Ordered keyword groups -> (metric path, builder). First matching group wins. Each entry
# yields (answer, usedMetrics, chart) when its metric is present in the snapshot.
def lookup_answer(
    question: str, metrics: dict[str, object]
) -> tuple[str, list[str], ChartSpec | None, str]:
    """Deterministic keyword -> metric lookup over the snapshot.

    Returns (answer, usedMetrics, chart, confidence). When no metric matches the
    question, returns a "not available in this snapshot" answer with confidence "low"
    so the surface never fabricates a number offline.
    """
    q = question.lower()
    tokens = {t.strip(".,!?;:()\"'") for t in q.replace("-", " ").replace("/", " ").split()}

    def has(*words: str) -> bool:
        # Phrases / hyphenated terms: substring on the full question. SHORT single tokens
        # (<=3 chars like "us"/"ops"): whole-word only, so they never match inside
        # "status"/"develops" and mis-route a question. Longer single tokens: substring
        # (so "engineer" still matches "engineering").
        for w in words:
            if " " in w or "-" in w:
                if w in q:
                    return True
            elif len(w) <= 3:
                if w in tokens:
                    return True
            elif w in q:
                return True
        return False

    # Department headcount.
    if has("department", "team", "engineer", "sales", "marketing", "ops"):
        val = get_path(metrics, "workforce.byDepartment")
        if isinstance(val, list) and val:
            return (
                _bucket_answer(val, "department"),
                ["workforce.byDepartment"],
                _bucket_chart(val, "Headcount by department"),
                "high",
            )

    # Location headcount.
    if has("location", "where", "office", "region", "europe", "us", "remote", "country"):
        val = get_path(metrics, "workforce.byLocation")
        if isinstance(val, list) and val:
            return (
                _bucket_answer(val, "location"),
                ["workforce.byLocation"],
                _bucket_chart(val, "Headcount by location"),
                "high",
            )

    # Level headcount.
    if has("level", "seniority", "senior", "junior", "staff", "principal"):
        val = get_path(metrics, "workforce.byLevel")
        if isinstance(val, list) and val:
            return (
                _bucket_answer(val, "level"),
                ["workforce.byLevel"],
                _bucket_chart(val, "Headcount by level"),
                "high",
            )

    # Employment type.
    if has("employment type", "contractor", "full-time", "full time", "part-time", "part time"):
        val = get_path(metrics, "workforce.byEmploymentType")
        if isinstance(val, list) and val:
            return (
                _bucket_answer(val, "employment type"),
                ["workforce.byEmploymentType"],
                _bucket_chart(val, "Headcount by employment type"),
                "high",
            )

    # Total headcount.
    if has("headcount", "how many people", "how many employees", "total", "company size"):
        val = get_path(metrics, "workforce.totalHeadcount")
        if val is not None:
            return (
                f"Total headcount is {fmt_count(val)}.",
                ["workforce.totalHeadcount"],
                None,
                "high",
            )

    # Time to fill / hire.
    if has("time to fill", "time-to-fill", "time to hire", "time-to-hire", "how long", "fill"):
        ttf = get_path(metrics, "recruiting.timeToFillDays")
        tth = get_path(metrics, "recruiting.timeToHireDays")
        if ttf is not None or tth is not None:
            bits = []
            used = []
            if ttf is not None:
                bits.append(f"average time-to-fill is {fmt_days(ttf)}")
                used.append("recruiting.timeToFillDays")
            if tth is not None:
                bits.append(f"average time-to-hire is {fmt_days(tth)}")
                used.append("recruiting.timeToHireDays")
            return ("Recruiting timing — " + "; ".join(bits) + ".", used, None, "high")

    # Offer acceptance.
    if has("offer", "acceptance", "accept"):
        val = get_path(metrics, "recruiting.offerAcceptanceRate")
        if val is not None:
            return (
                f"The offer-acceptance rate is {fmt_pct(val)}.",
                ["recruiting.offerAcceptanceRate"],
                None,
                "high",
            )

    # Open roles.
    if has("open role", "open position", "openings", "vacancies", "roles open"):
        val = get_path(metrics, "recruiting.openRoles")
        if val is not None:
            return (
                f"There are {fmt_count(val)} open role(s).",
                ["recruiting.openRoles"],
                None,
                "high",
            )

    # SLA breaches.
    if has("sla", "breach", "overdue", "past due", "open too long"):
        val = get_path(metrics, "recruiting.slaBreaches")
        if isinstance(val, list):
            if val:
                names = ", ".join(
                    f"{b.get('title')} ({b.get('daysOpen')}d)"
                    for b in val
                    if isinstance(b, dict)
                )
                return (
                    f"{fmt_count(len(val))} role(s) are past SLA: {names}.",
                    ["recruiting.slaBreaches"],
                    None,
                    "high",
                )
            return ("No roles are past SLA in this snapshot.", ["recruiting.slaBreaches"], None, "high")

    # Source of hire.
    if has("source", "where do", "channel", "linkedin", "referral", "job board"):
        val = get_path(metrics, "recruiting.sourceOfHire")
        if isinstance(val, list) and val:
            series: list[ChartPoint] = []
            parts = []
            for s in val:
                if isinstance(s, dict) and s.get("source") is not None:
                    cnt = _as_float(s.get("count"))
                    if cnt is not None:
                        series.append(ChartPoint(label=str(s.get("source")), value=cnt))
                        parts.append(f"{s.get('source')}: {fmt_count(s.get('count'))}")
            chart = ChartSpec(type="PIE", title="Source of hire", series=series) if series else None
            return ("Source of hire — " + "; ".join(parts) + ".", ["recruiting.sourceOfHire"], chart, "high")

    # New-hire success.
    if has("new hire", "new-hire", "90-day", "90 day", "ramp"):
        val = get_path(metrics, "workforce.newHireSuccessRate")
        if val is not None:
            return (
                f"New-hire success is {fmt_pct(val)} at the 90-day mark.",
                ["workforce.newHireSuccessRate"],
                None,
                "high",
            )

    # Span of control.
    if has("span", "direct report", "reports", "manager"):
        val = get_path(metrics, "workforce.spanOfControl")
        if isinstance(val, list) and val:
            wide = sum(1 for s in val if isinstance(s, dict) and s.get("flag") == "WIDE")
            narrow = sum(1 for s in val if isinstance(s, dict) and s.get("flag") == "NARROW")
            return (
                f"Across {fmt_count(len(val))} managers: {fmt_count(wide)} WIDE (>8 reports) "
                f"and {fmt_count(narrow)} NARROW (<3 reports).",
                ["workforce.spanOfControl"],
                None,
                "high",
            )

    # Nothing matched — be honest, set low confidence, never fabricate.
    return (
        "[OFFLINE] I can't answer that from the current metrics snapshot. The deterministic "
        "offline lookup covers headcount (by department / location / level / employment type), "
        "open roles, time-to-fill/hire, offer acceptance, SLA breaches, source of hire, "
        "new-hire success, and span of control. Please rephrase toward one of those, or run "
        "with the LLM enabled for a fuller answer.",
        [],
        None,
        "low",
    )


__all__ = [
    "FlagSeverity",
    "detect_anomalies",
    "fmt_count",
    "fmt_days",
    "fmt_pct",
    "get_path",
    "lookup_answer",
]
