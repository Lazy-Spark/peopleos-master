"""Module 5e — AI workforce-analytics narrative + anomaly prompt.

Turns a frozen ``DashboardMetrics`` snapshot (computed in the API from Postgres;
prod: Snowflake + DBT) into an executive narrative: a headline, a 3-paragraph
"the most important people metrics THIS PERIOD" narrative, a keyMetrics list, and
anomalies (each carrying a FlagSeverity). The model NEVER queries data and NEVER
generates SQL — it is grounded ONLY in the supplied metrics dict.

Follows the 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role / context / task / output_schema / constraints)
  #2 hallucination prevention — every number must come from the supplied metrics; the
     model may not invent, extrapolate, or estimate values
  #5 exact output schema for Pydantic validation
  #6 versioned (PROMPT_VERSION) — persisted on every output
  #7 privacy — the snapshot is aggregate; do not single out or speculate about
     individuals beyond the manager names already present in the spanOfControl rows
Includes >= 2 few-shot examples.
"""

from __future__ import annotations

import json

PROMPT_VERSION = "module5.analytics_narrative@1.0.0"

# Exact JSON schema the model must emit (camelCase, mirrors AnalyticsNarrativeResponse
# minus the modelVersion/promptVersion fields, which this service stamps on).
_OUTPUT_SCHEMA = """{
  "headline": string,                         // one-line takeaway for leadership
  "narrative": string,                        // EXACTLY 3 paragraphs, blank-line separated
  "keyMetrics": [                             // the most important metrics THIS PERIOD
    { "label": string, "value": string, "note": string | null }
  ],
  "anomalies": [                             // notable / out-of-range values worth a flag
    { "metric": string, "detail": string, "severity": "LOW" | "MEDIUM" | "HIGH" }
  ]
}"""

# Few-shot examples use compact, illustrative metric snapshots (NOT real org data) so the
# model learns the grounding discipline + the exact output shape.
_FEW_SHOT = """<few_shot_examples>
  <example>
    <metrics>{"recruiting":{"openRoles":12,"timeToFillDays":61,"offerAcceptanceRate":0.58,"slaBreaches":[{"jobId":"j1","title":"Staff SRE","daysOpen":74},{"jobId":"j2","title":"Data Engineer","daysOpen":69}],"conversionRates":[{"from":"SCREEN","to":"INTERVIEW","rate":0.22}]},"workforce":{"totalHeadcount":340,"spanOfControl":[{"managerName":"A. Rivera","directReports":11,"flag":"WIDE"}],"newHireSuccessRate":0.71},"engagement":{"available":false},"skills":{"available":false}}</metrics>
    <output>{"headline":"Hiring velocity is the watch item: two roles past SLA and a soft 58% offer-accept rate.","narrative":"Recruiting is the period's headline. Twelve roles are open with an average time-to-fill of 61 days, and two of them — Staff SRE (74 days) and Data Engineer (69 days) — have now breached SLA, concentrating the risk in senior technical hiring.\\n\\nFunnel efficiency is the second story. The screen-to-interview conversion is 0.22, meaning fewer than a quarter of screened candidates advance; combined with a 58% offer-acceptance rate, the team is working a wide top-of-funnel to land each hire. New-hire success sits at 71%, a reasonable but not standout signal that selection quality is holding.\\n\\nWorkforce structure is stable at 340 employees, with one span-of-control flag: A. Rivera carries 11 direct reports (WIDE), a load worth reviewing for coaching capacity. Engagement and skills analytics are not yet available this period.","keyMetrics":[{"label":"Open roles","value":"12","note":"avg 61 days to fill"},{"label":"SLA breaches","value":"2","note":"Staff SRE, Data Engineer"},{"label":"Offer acceptance","value":"58%","note":"below a healthy ~70% bar"},{"label":"New-hire success","value":"71%","note":"90-day mark with good perf"}],"anomalies":[{"metric":"recruiting.slaBreaches","detail":"2 roles open past SLA (Staff SRE 74d, Data Engineer 69d).","severity":"HIGH"},{"metric":"workforce.spanOfControl","detail":"A. Rivera has 11 direct reports (WIDE; >8).","severity":"MEDIUM"},{"metric":"recruiting.conversionRates","detail":"Screen-to-interview conversion is 0.22, below ~0.3.","severity":"MEDIUM"}]}</output>
  </example>
  <example>
    <metrics>{"recruiting":{"openRoles":3,"timeToFillDays":34,"offerAcceptanceRate":0.91,"slaBreaches":[],"conversionRates":[{"from":"SCREEN","to":"INTERVIEW","rate":0.46}]},"workforce":{"totalHeadcount":58,"spanOfControl":[{"managerName":"L. Chen","directReports":2,"flag":"NARROW"}],"promotionRateByLevel":[{"level":"SENIOR","promoted":0,"total":14,"rate":0.0}],"newHireSuccessRate":0.95},"engagement":{"available":false},"skills":{"available":false}}</metrics>
    <output>{"headline":"A healthy recruiting quarter; the one bottleneck is zero senior-level promotions.","narrative":"Recruiting is in good shape. With three open roles, a 34-day average time-to-fill, a 91% offer-acceptance rate, and no SLA breaches, the team is converting efficiently — the screen-to-interview rate of 0.46 is well above a healthy bar.\\n\\nSelection quality reinforces the picture: new-hire success is 95% at the 90-day mark, suggesting the bar set in interviews is translating into performance. There is little funnel waste to flag this period.\\n\\nThe development pipeline is the exception worth watching. No senior-level employees were promoted out of a cohort of 14 (0% promotion rate), a potential bottleneck for retention and progression. Separately, L. Chen manages only 2 reports (NARROW), which may indicate an under-scaled team. Engagement and skills analytics are not yet available.","keyMetrics":[{"label":"Time-to-fill","value":"34 days","note":"no SLA breaches"},{"label":"Offer acceptance","value":"91%","note":"strong"},{"label":"New-hire success","value":"95%","note":"selection quality holding"},{"label":"Senior promotion rate","value":"0%","note":"0 of 14 promoted"}],"anomalies":[{"metric":"workforce.promotionRateByLevel","detail":"0% promotion rate at SENIOR (0 of 14) — progression bottleneck.","severity":"MEDIUM"},{"metric":"workforce.spanOfControl","detail":"L. Chen has 2 direct reports (NARROW; <3).","severity":"LOW"}]}</output>
  </example>
</few_shot_examples>"""


def build_narrative_system_prompt(org_context: dict[str, object] | None = None) -> str:
    """XML-tagged system prompt for the analytics narrative (prompt standard #1).

    ``org_context`` (optional) personalises the <context> block; when absent the prompt
    uses generic framing.
    """
    oc = org_context or {}
    org_name = oc.get("orgName") or "the organisation"
    industry = oc.get("industry") or "unspecified industry"
    headcount = oc.get("headcount")
    user_role = oc.get("userRole") or "HR / People Ops leader"
    size = f"~{headcount} employees" if headcount else "size unspecified"
    custom = oc.get("customRules") or []
    custom_block = (
        "\n    - Org-specific rules: " + "; ".join(str(r) for r in custom)
        if isinstance(custom, list) and custom
        else ""
    )
    return f"""<system>
  <role>Senior HR / people-analytics expert writing an executive workforce briefing for {org_name}.</role>
  <context>
    - Organisation: {org_name} ({industry}), {size}.
    - Reader: {user_role} — write for an executive audience: clear, concrete, decision-useful.{custom_block}
    - You are given a METRICS SNAPSHOT for the current period, already computed from the
      org's data warehouse. You do NOT have database access and you NEVER write SQL.
  </context>
  <task_definition>
    Read the metrics snapshot in the user message and produce:
      1. headline — a single sentence naming the period's most important takeaway.
      2. narrative — EXACTLY 3 short paragraphs (blank-line separated) covering the org's
         MOST IMPORTANT people metrics THIS PERIOD (e.g. recruiting velocity/funnel,
         workforce structure, selection quality, progression). Lead with what matters.
      3. keyMetrics — 3 to 6 of the most important metrics as {{label, value, note}}.
         Format values for humans (e.g. "58%", "34 days", "12").
      4. anomalies — notable / out-of-range values worth a flag, each with a severity.
         Examples: WIDE/NARROW span of control, SLA breaches, low stage conversion
         (< ~0.3), low offer-acceptance, low new-hire success, promotion bottlenecks.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    - GROUND EVERY NUMBER in the supplied metrics. Never invent, estimate, extrapolate,
      or carry over numbers from the examples. If a value is null or a section is
      unavailable (available:false), say so plainly — do not fabricate it.
    - Do NOT generate SQL or describe queries; you are narrating a fixed snapshot.
    - Sections marked available:false (engagement, skills) have no data yet — note that
      they are pending rather than reporting zeros as if real.
    - Advisory only: surface issues and suggest what to review; never make or imply an
      employment decision about any individual.
    - Privacy: the snapshot is aggregate. Reference only the manager names already present
      in spanOfControl; do not infer protected attributes or personal circumstances.
    - severity: HIGH for clear, urgent problems (e.g. SLA breaches); MEDIUM for items
      worth review (WIDE span, weak conversion); LOW for minor / watch items (NARROW span).
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_narrative_user_prompt(metrics: dict[str, object]) -> str:
    """Wrap the metrics snapshot for the user turn."""
    blob = json.dumps(metrics, default=str, sort_keys=True)
    return (
        "<metrics>\n"
        f"{blob}\n"
        "</metrics>\n\n"
        "Write the executive briefing as a single JSON object. Ground every number in "
        "the metrics above."
    )
