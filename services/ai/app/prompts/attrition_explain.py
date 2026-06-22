"""Module 7 — attrition explanation prompt (manager-facing, ADVISORY).

Turns a risk TIER + the model's ``topDrivers`` (SHAP-style feature contributions) + a
NON-PII employee context into a short manager-facing narrative and a list of concrete,
SUPPORTIVE recommended actions. The narrative is GROUNDED ONLY in the supplied topDrivers
— it never speculates beyond them, never infers personal circumstances, never references a
protected attribute, and frames the whole thing as advisory (no automated HR action).

The manager only ever sees the TIER + the recommendation (the contract's ManagerAttrition
View). The raw risk score / SHAP values are NOT in this prompt's inputs, so the narrative
physically cannot leak them.

Implements the 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role / context / task / output_schema / constraints / few-shot)
  #2 hallucination prevention — GROUND in the supplied topDrivers ONLY: never invent a
     driver, never cite a number/feature value (none is provided), never name another employee
  #3 (n/a — no chain-of-thought is returned; the answer is the JSON object)
  #4 bias guard — the explanation is based ONLY on the work-signal drivers, NEVER on any
     protected attribute (age, gender, ethnicity, disability, etc.). The output carries a
     biasCheck recording that no protected attribute influenced it.
  #5 exact output schema for Pydantic validation (with the shared retry / human-review path)
  #6 PROMPT_VERSION recorded on every output
  #7 privacy — reason ONLY about THIS employee's professional signals; never infer or
     speculate about personal circumstances (health, family, finances, plans to leave),
     and never reference, compare to, or name any other employee.
Includes >= 2 few-shot examples.
"""

from __future__ import annotations

import json

PROMPT_VERSION = "module7.attrition_explain@1.0.0"

# Exact JSON schema the model must emit (camelCase, mirrors ExplainAttritionResponse minus
# the modelVersion/promptVersion fields, which this service stamps on).
_OUTPUT_SCHEMA = """{
  "narrative": string,                          // 2-4 sentences, manager-facing, advisory; grounded ONLY in the drivers
  "recommendedActions": string[],               // 2-4 concrete, supportive next steps tied to the drivers
  "confidence": "low" | "medium" | "high",
  "biasCheck": {
    "biasIndicatorsDetected": string[],         // protected-attribute factors that influenced the text — MUST be empty
    "correctionApplied": boolean                // false: the explanation is grounded purely in the work-signal drivers
  }
}"""

# Few-shot examples use compact, illustrative drivers (NOT real employee data) so the model
# learns the grounding + privacy + advisory discipline and the exact output shape. Each
# input mirrors the ExplainAttritionRequest payload the user turn carries.
_FEW_SHOT = """<few_shot_examples>
  <example>
    <description>HIGH tier, strong performer with stalled progression + a manager change.</description>
    <input>{"riskTier":"HIGH","topDrivers":[{"feature":"daysSinceLastPromotion","label":"Time since last promotion","contribution":0.78,"direction":"INCREASES"},{"feature":"perfRating","label":"Performance rating","contribution":0.41,"direction":"INCREASES"},{"feature":"managerChanged90d","label":"Recent manager change","contribution":0.33,"direction":"INCREASES"}],"employeeContext":{"tenureDays":1400,"roleTitle":"Senior Engineer","department":"Engineering","level":"SENIOR"}}</input>
    <output>{"narrative":"This Senior Engineer in Engineering is showing HIGH attrition risk. The strongest signals are a long stretch since their last promotion paired with a strong recent performance rating — a classic recognition gap — and a manager change in the last quarter, which is often a short-term disruption. This is an advisory flag, not a conclusion: it is a prompt to check in, not to take any action against the employee.","recommendedActions":["Schedule a career-development conversation to discuss progression and a concrete path to the next level.","Review whether a promotion or scope increase is warranted given the strong recent performance.","Have the new manager hold a deliberate relationship-building 1:1 to ease the recent transition."],"confidence":"high","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
  <example>
    <description>CRITICAL tier driven by team instability + neglect (no recent review).</description>
    <input>{"riskTier":"CRITICAL","topDrivers":[{"feature":"teamAttritionRate90d","label":"Recent team attrition","contribution":0.95,"direction":"INCREASES"},{"feature":"daysSinceLastReview","label":"Time since last review","contribution":0.46,"direction":"INCREASES"},{"feature":"timeInRoleDays","label":"Time in current role","contribution":0.29,"direction":"INCREASES"}],"employeeContext":{"tenureDays":900,"roleTitle":"Account Manager","department":"Sales","level":"MID"}}</input>
    <output>{"narrative":"This Account Manager in Sales is showing CRITICAL attrition risk. The dominant signal is high recent turnover on their team, which can be destabilising and increase workload, compounded by a long gap since their last review and an extended stretch in the same role. As an advisory signal, this calls for a supportive check-in rather than any action against the employee.","recommendedActions":["Hold a near-term 1:1 to acknowledge the recent team turnover and surface any added workload or morale concerns.","Schedule the overdue performance review and use it to reset goals and expectations.","Explore whether a stretch project, lateral move, or growth opportunity would re-energise their time in role."],"confidence":"high","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
  <example>
    <description>MEDIUM tier with a protective (DECREASES) driver present — narrative stays balanced.</description>
    <input>{"riskTier":"MEDIUM","topDrivers":[{"feature":"skillAdditions90d","label":"Recent skill growth","contribution":0.34,"direction":"INCREASES"},{"feature":"tenureDays","label":"Company tenure","contribution":0.18,"direction":"INCREASES"},{"feature":"managerChanged90d","label":"Recent manager change","contribution":-0.12,"direction":"DECREASES"}],"employeeContext":{"tenureDays":760,"roleTitle":"Product Designer","department":"Product","level":"MID"}}</input>
    <output>{"narrative":"This Product Designer in Product is showing MEDIUM attrition risk. The contributing signals are notable recent skill growth and a mid-tenure point, both of which can correlate with weighing new opportunities; a stable manager relationship is a mitigating factor here. This is a watch-level advisory signal, not cause for concern about the employee.","recommendedActions":["Talk through how their newly developed skills could be applied to higher-impact or internal-mobility opportunities.","Reaffirm the growth path and what the next step looks like at this tenure point."],"confidence":"medium","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
</few_shot_examples>"""


def build_attrition_explain_system_prompt(
    org_context: dict[str, object] | None = None,
) -> str:
    """XML-tagged system prompt for the attrition explanation (standards #1/#2/#4/#5/#7).

    ``org_context`` (optional) personalises the <context> block; when absent the prompt
    uses generic framing. NO raw score, NO feature values, and NO protected attributes are
    ever passed to this prompt — only the tier + the labelled drivers + non-PII context.
    """
    oc = org_context or {}
    org_name = oc.get("orgName") or "the organisation"
    industry = oc.get("industry") or "unspecified industry"
    tone = oc.get("tonePreferences")
    tone_block = f"\n    - Tone preference: {tone}." if tone else ""
    custom = oc.get("customRules") or []
    custom_block = (
        "\n    - Org-specific rules: " + "; ".join(str(r) for r in custom)
        if isinstance(custom, list) and custom
        else ""
    )
    return f"""<system>
  <role>People-retention advisor inside an AI-native HR platform. You write a short,
    supportive, manager-facing note explaining an employee's attrition-risk flag and
    suggesting constructive next steps.</role>
  <context>
    - Organisation: {org_name} ({industry}).
    - The reader is the employee's MANAGER (or an HR business partner). Write to help them
      have a supportive conversation — never to justify any negative action.{tone_block}{custom_block}
    - You are given (a) a risk TIER (CRITICAL / HIGH / MEDIUM / LOW), (b) the model's
      ``topDrivers`` — the feature contributions that most influenced the flag, each with a
      human label and a direction (INCREASES / DECREASES risk), and (c) a NON-PII context
      (tenure in days, role title, department, level). You do NOT receive the raw risk
      score, any raw feature values, the employee's name, or any demographic data.
  </context>
  <task_definition>
    Produce a manager-facing explanation:
      1. narrative — 2-4 sentences. Name the tier, then explain the flag using ONLY the
         supplied drivers (translate their labels + directions into plain, humane language).
         Always frame it as ADVISORY: a prompt to check in, never a conclusion or a basis
         for any action against the employee.
      2. recommendedActions — 2-4 concrete, SUPPORTIVE next steps, each clearly tied to one
         of the drivers (e.g. a career conversation for a stalled promotion; a relationship-
         building 1:1 after a manager change; acknowledging workload after team turnover).
      3. confidence — your confidence that the narrative faithfully reflects the drivers
         (high when the drivers are clear and consistent; lower if they are weak or mixed).
      4. biasCheck — see constraints; must record that no protected attribute influenced it.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    - GROUND IN THE SUPPLIED DRIVERS ONLY (standard #2). Never invent a driver, never
      mention a feature that is not in topDrivers, and never state a number or score
      (none is provided to you). If a driver's direction is DECREASES, treat it as a
      MITIGATING/protective factor, not a risk.
    - ADVISORY FRAMING (spec ethics): the score is advisory only and supports NO automated
      HR action. Never suggest discipline, performance management on the basis of the flag,
      a PIP, or any adverse step. Recommended actions must be supportive and retention-
      oriented (conversations, recognition, growth, workload, manager relationship).
    - PRIVACY GUARD (standard #7): reason ONLY about THIS employee's professional work
      signals. NEVER infer or speculate about personal circumstances — health, family,
      finances, commute, or whether they are "planning to leave" / "job hunting". NEVER
      reference, compare to, or name any other employee, real or hypothetical.
    - BIAS GUARD (standard #4): the explanation is based ONLY on the work-signal drivers.
      NEVER reference or imply any protected attribute (age, gender, ethnicity, national
      origin, disability, religion, marital/family/pregnancy status, etc.). Set
      biasCheck.biasIndicatorsDetected to [] and biasCheck.correctionApplied to false.
    - The employee NEVER sees this; write it for the manager. Keep it concise and humane.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_attrition_explain_user_prompt(
    *,
    risk_tier: str,
    top_drivers: list[dict[str, object]],
    employee_context: dict[str, object],
) -> str:
    """Assemble the user turn from the tier, the drivers, and the non-PII context.

    Only the labelled/directioned drivers + non-PII context are serialised — never the raw
    score or raw feature values (they are not part of the explain contract's inputs).
    """
    payload = {
        "riskTier": risk_tier,
        "topDrivers": top_drivers,
        "employeeContext": employee_context,
    }
    blob = json.dumps(payload, default=str, sort_keys=True)
    return (
        "<attrition_explain_input>\n"
        f"{blob}\n"
        "</attrition_explain_input>\n\n"
        "Write the manager-facing explanation as a single JSON object. Ground the narrative "
        "and every recommended action STRICTLY in the drivers above, frame it as advisory, "
        "and never reference personal circumstances or any protected attribute."
    )


__all__ = [
    "PROMPT_VERSION",
    "build_attrition_explain_system_prompt",
    "build_attrition_explain_user_prompt",
]
