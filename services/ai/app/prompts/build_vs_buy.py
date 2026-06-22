"""Module 6c — Org-wide skill inventory "Build vs Buy" prompt.

Given a single skill with its current internal supply, its demand (open roles requiring
it), and how many current employees are trainable into the gap (1-2 skills away), the
model recommends whether the org should BUILD (train internally), BUY (hire externally),
or pursue a HYBRID of both — with a concise rationale grounded ONLY in the supplied
numbers.

Implements the 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role / context / task / output_schema / constraints / few-shot)
  #2 hallucination prevention — reason ONLY from the supplied numbers; never invent costs,
     timelines, head counts, or market data that were not provided
  #5 exact output schema for Pydantic validation (with the shared retry / human-review path)
  #6 PROMPT_VERSION recorded on every output
  #7 privacy — the inputs are aggregate counts; never name or speculate about individuals
Includes >= 2 few-shot examples.

The deterministic decision rule (also the offline fallback) is encoded in the prompt so the
LLM rationale stays consistent with what the API would compute:
  gap = max(0, demand - currentSupply)
  - gap == 0                                  -> BUILD  (no shortfall; develop bench depth)
  - trainableInternally >= gap (gap > 0)      -> BUILD  (the internal pool can close the gap)
  - trainableInternally == 0 (gap > 0)        -> BUY    (no internal pool to train)
  - else (0 < trainableInternally < gap)      -> HYBRID (train some, hire the remainder)
"""

from __future__ import annotations

import json

PROMPT_VERSION = "module6.build_vs_buy@1.0.0"

# Exact JSON schema the model must emit (camelCase, mirrors BuildVsBuyResponse minus the
# modelVersion/promptVersion fields, which this service stamps on).
_OUTPUT_SCHEMA = """{
  "recommendation": "BUILD" | "BUY" | "HYBRID",
  "rationale": string                          // 1-3 sentences grounded in the supplied numbers
}"""

# Few-shot examples use compact, illustrative numbers (NOT real org data) so the model
# learns the decision rule + the exact output shape, and keeps the rationale grounded.
_FEW_SHOT = """<few_shot_examples>
  <example>
    <description>Gap of 4, with 6 trainable internally — the internal pool can cover it: BUILD.</description>
    <input>{"skill":"Kubernetes","currentSupply":3,"demand":7,"trainableInternally":6}</input>
    <output>{"recommendation":"BUILD","rationale":"Demand of 7 against a supply of 3 leaves a gap of 4, and 6 current employees are 1-2 skills away from Kubernetes. The internal pool can fully close the gap, so train rather than hire."}</output>
  </example>
  <example>
    <description>Gap of 3 with nobody trainable internally: BUY.</description>
    <input>{"skill":"Rust","currentSupply":1,"demand":4,"trainableInternally":0}</input>
    <output>{"recommendation":"BUY","rationale":"A demand of 4 versus a supply of 1 is a gap of 3, and no current employees are close enough to train into Rust. With no internal pool to develop, hiring externally is the only path to close the gap."}</output>
  </example>
  <example>
    <description>Gap of 5 with only 2 trainable internally: HYBRID.</description>
    <input>{"skill":"Data Engineering","currentSupply":4,"demand":9,"trainableInternally":2}</input>
    <output>{"recommendation":"HYBRID","rationale":"Demand of 9 against a supply of 4 is a gap of 5, but only 2 employees are trainable into it. Train those 2 and hire the remaining ~3 externally to fully close the gap."}</output>
  </example>
  <example>
    <description>No shortfall (supply meets demand): BUILD bench depth.</description>
    <input>{"skill":"Python","currentSupply":12,"demand":8,"trainableInternally":5}</input>
    <output>{"recommendation":"BUILD","rationale":"Supply of 12 already meets the demand of 8, so there is no hiring shortfall. Invest in deepening the existing bench rather than hiring for this skill."}</output>
  </example>
</few_shot_examples>"""


def build_build_vs_buy_system_prompt(org_context: dict[str, object] | None = None) -> str:
    """XML-tagged system prompt for build-vs-buy (prompt standards #1/#2/#5/#7).

    ``org_context`` (optional) personalises the <context> block; when absent the prompt
    uses generic framing.
    """
    oc = org_context or {}
    org_name = oc.get("orgName") or "the organisation"
    industry = oc.get("industry") or "unspecified industry"
    custom = oc.get("customRules") or []
    custom_block = (
        "\n    - Org-specific rules: " + "; ".join(str(r) for r in custom)
        if isinstance(custom, list) and custom
        else ""
    )
    return f"""<system>
  <role>Workforce-planning advisor inside an AI-native HR platform. You advise whether to
    close a skill gap by training current employees (BUILD), hiring externally (BUY), or
    a mix (HYBRID).</role>
  <context>
    - Organisation: {org_name} ({industry}).
    - You are given a single SKILL with three counts: currentSupply (employees who hold
      the skill), demand (open roles requiring it), and trainableInternally (current
      employees who are 1-2 skills away and could be trained into the gap).{custom_block}
    - These are aggregate counts. You have no other data — no cost, salary, market, or
      timeline figures.
  </context>
  <task_definition>
    Decide BUILD, BUY, or HYBRID using this rule, then explain it:
      gap = max(0, demand - currentSupply)
      - gap == 0                                 -> BUILD  (no shortfall; deepen the bench)
      - gap > 0 and trainableInternally >= gap   -> BUILD  (internal pool can close the gap)
      - gap > 0 and trainableInternally == 0     -> BUY    (no internal pool to train)
      - otherwise (0 < trainableInternally < gap)-> HYBRID (train some, hire the remainder)
    Write a concise rationale (1-3 sentences) that names the gap and the trainable pool.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    - GROUND IN THE SUPPLIED NUMBERS ONLY. Never invent costs, time-to-hire, salaries,
      attrition, market scarcity, or any figure that was not provided.
    - Follow the decision rule exactly so the recommendation is reproducible and auditable.
    - Privacy (standard #7): the inputs are aggregate counts — never name or speculate
      about any individual employee or candidate.
    - Keep the rationale concise and decision-useful; do not add a preamble or commentary.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_build_vs_buy_user_prompt(
    *,
    skill: str,
    current_supply: int,
    demand: int,
    trainable_internally: int,
) -> str:
    """Assemble the user turn from the skill and its supply/demand/trainable counts."""
    payload = {
        "skill": skill,
        "currentSupply": current_supply,
        "demand": demand,
        "trainableInternally": trainable_internally,
    }
    blob = json.dumps(payload, default=str, sort_keys=True)
    return (
        "<build_vs_buy_input>\n"
        f"{blob}\n"
        "</build_vs_buy_input>\n\n"
        "Apply the decision rule and return a single JSON object. Ground the rationale in "
        "the numbers above."
    )
