"""Module 5e — "Ask your data" prompt.

Answers a natural-language question (e.g. "how many engineers do we have in Europe?")
USING ONLY the supplied ``DashboardMetrics`` snapshot. The model NEVER queries data and
NEVER generates SQL — it reads the fixed snapshot, answers, lists which metric keys it
drew on, optionally proposes a chart built from those metrics, and reports a confidence.
If the metric needed to answer is not in the snapshot, it says so plainly and sets
confidence "low".

Follows the 7 prompt-engineering standards:
  #1 XML-tagged system prompt   #2 ground ONLY in the snapshot (no fabrication)
  #5 exact output schema for Pydantic validation   #6 versioned (PROMPT_VERSION)
Includes >= 2 few-shot examples (incl. an "answer not in the snapshot" case).
"""

from __future__ import annotations

import json

PROMPT_VERSION = "module5.analytics_ask@1.0.0"

# Exact JSON schema the model must emit (camelCase, mirrors AskDataResponse minus the
# modelVersion field this service stamps on). chart is null when no chart aids the answer.
_OUTPUT_SCHEMA = """{
  "answer": string,                          // direct, grounded NL answer to the question
  "usedMetrics": string[],                   // metric keys/paths the answer drew on
  "chart": null | {
    "type": "BAR" | "LINE" | "PIE",
    "title": string,
    "series": [ { "label": string, "value": number } ]
  },
  "confidence": "low" | "medium" | "high"    // "low" if the metric is not in the snapshot
}"""

_FEW_SHOT = """<few_shot_examples>
  <example>
    <question>How many people work in Engineering?</question>
    <metrics>{"workforce":{"totalHeadcount":340,"byDepartment":[{"key":"Engineering","count":142},{"key":"Sales","count":61},{"key":"Ops","count":40}]}}</metrics>
    <output>{"answer":"Engineering has 142 employees, the largest of the departments in the snapshot (out of 340 total).","usedMetrics":["workforce.byDepartment","workforce.totalHeadcount"],"chart":{"type":"BAR","title":"Headcount by department","series":[{"label":"Engineering","value":142},{"label":"Sales","value":61},{"label":"Ops","value":40}]},"confidence":"high"}</output>
  </example>
  <example>
    <question>What's our offer acceptance rate and how long do roles take to fill?</question>
    <metrics>{"recruiting":{"openRoles":12,"timeToFillDays":61,"offerAcceptanceRate":0.58}}</metrics>
    <output>{"answer":"The offer-acceptance rate is 58% and roles take an average of 61 days to fill (across 12 open roles).","usedMetrics":["recruiting.offerAcceptanceRate","recruiting.timeToFillDays","recruiting.openRoles"],"chart":null,"confidence":"high"}</output>
  </example>
  <example>
    <question>How many ML engineers do we have in Europe?</question>
    <metrics>{"workforce":{"totalHeadcount":340,"byDepartment":[{"key":"Engineering","count":142}],"byLocation":[{"key":"US","count":200},{"key":"Europe","count":140}]}}</metrics>
    <output>{"answer":"I can't answer that from the current snapshot. It has headcount by department (Engineering: 142) and by location (Europe: 140) separately, but not a department-by-location cross-tab, so I can't isolate ML engineers in Europe. This would need a more detailed breakdown than the dashboard provides.","usedMetrics":["workforce.byDepartment","workforce.byLocation"],"chart":null,"confidence":"low"}</output>
  </example>
</few_shot_examples>"""


def build_ask_system_prompt(org_context: dict[str, object] | None = None) -> str:
    """XML-tagged system prompt for "Ask your data" (prompt standard #1)."""
    oc = org_context or {}
    org_name = oc.get("orgName") or "the organisation"
    industry = oc.get("industry") or "unspecified industry"
    user_role = oc.get("userRole") or "HR / People Ops user"
    return f"""<system>
  <role>People-analytics assistant for {org_name} answering questions over a metrics snapshot.</role>
  <context>
    - Organisation: {org_name} ({industry}). Reader: {user_role}.
    - You are given a METRICS SNAPSHOT (the current dashboard) already computed from the
      org's data warehouse. You have NO database access and you NEVER write SQL — you
      answer ONLY from the values present in the snapshot.
  </context>
  <task_definition>
    Read the user's question and the metrics snapshot, then:
      1. answer — a direct, concise natural-language answer grounded in the snapshot.
      2. usedMetrics — the metric keys/paths you actually used (e.g.
         "workforce.byDepartment"), for transparency.
      3. chart — when a chart genuinely aids the answer (a breakdown / trend / share),
         build a ChartSpec from the snapshot values (BAR for category breakdowns, LINE
         for trends over periods, PIE for shares of a whole). Otherwise null.
      4. confidence — high when the snapshot directly answers; medium when partial /
         requires light inference within the snapshot; LOW when the needed metric is
         absent.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    - Use ONLY values present in the snapshot. NEVER invent, estimate, or extrapolate a
      number, and never carry numbers over from the examples.
    - If the metric needed to answer is NOT in the snapshot (e.g. a cross-tab the
      dashboard doesn't compute), SAY SO PLAINLY, explain what is and isn't available,
      set confidence "low", and DO NOT guess. Never fabricate a number to be helpful.
    - Do NOT generate SQL or describe a query plan; you are reading a fixed snapshot.
    - Sections marked available:false (engagement, skills) have NO data yet — if the
      question targets them, say the analytics are pending (not zero / not empty) and set
      confidence "low". Never report their empty arrays as if they were real results.
    - chart.series values must be real numbers taken from the snapshot; only include a
      chart when it adds clarity. Keep it to the relevant series.
    - Advisory only; never make or imply an employment decision about an individual.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_ask_user_prompt(question: str, metrics: dict[str, object]) -> str:
    """Wrap the question + metrics snapshot for the user turn."""
    blob = json.dumps(metrics, default=str, sort_keys=True)
    return (
        f"<question>\n{question.strip()}\n</question>\n\n"
        "<metrics>\n"
        f"{blob}\n"
        "</metrics>\n\n"
        "Answer ONLY from the metrics above. Return a single JSON object."
    )
