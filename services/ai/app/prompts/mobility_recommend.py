"""Module 8 — internal MOVE recommendation prompt (employee-facing, ADVISORY).

Turns a candidate internal move (a target role + the employee's skill match — the
``matchedSkills`` they already have and the ``missingSkills`` the role still requires —
plus a readiness tier and a NON-PII employee/org context) into a concise FIT SUMMARY and
a DEVELOPMENT PLAN: one ``DevelopmentStep`` per MISSING skill (the skill + a concrete
action + an optional suggested resource). The whole thing is GROUNDED ONLY in the supplied
matched/missing skills — it never invents a skill the employee has or needs.

The matching itself is computed UPSTREAM by the skill-graph (the Node API's
``skillGap(employee, role)`` → matched / missing / coverage → matchScore + readiness);
this surface only narrates and plans over that result. The raw match score is not passed
in (the employee sees readiness + the plan, not a number), so the text cannot leak it.

Implements the 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role / context / task / output_schema / constraints / few-shot)
  #2 hallucination prevention — GROUND in the supplied matched/missing skills ONLY: never
     claim the employee already holds a skill not in matchedSkills, never add a development
     step for a skill not in missingSkills, never invent a role requirement
  #3 (n/a — no chain-of-thought is returned; the answer is the JSON object)
  #4 bias guard — the recommendation is based ONLY on the skill match and the target role;
     NEVER on any protected attribute (age, gender, ethnicity, disability, etc.). The model
     emits a ``biasCheck`` recording that no protected attribute influenced it.
  #5 exact output schema for Pydantic validation (with the shared retry / human-review path)
  #6 PROMPT_VERSION recorded on every output
  #7 privacy — reason ONLY about THIS employee's own skills + role; never reference,
     compare to, or name any other employee, real or hypothetical.
Includes >= 2 few-shot examples.
"""

from __future__ import annotations

import json

PROMPT_VERSION = "module8.mobility_recommend@1.0.0"

# Exact JSON schema the model must emit (camelCase, mirrors MobilityRecommendResponse minus
# the modelVersion/promptVersion fields, which this service stamps on).
_OUTPUT_SCHEMA = """{
  "fitSummary": string,                         // 1-3 sentences: why this internal move fits, framed as advisory
  "developmentPlan": [                           // ONE entry per MISSING skill (in the order missingSkills lists them)
    {
      "skill": string,                          // the missing required skill, exactly as named in missingSkills
      "action": string,                         // a concrete, development-oriented action to build that skill
      "suggestedResource": string | null        // an optional concrete resource/course; null if none fits
    }
  ],
  "confidence": "low" | "medium" | "high",
  "biasCheck": {
    "biasIndicatorsDetected": string[],         // protected-attribute factors that influenced the text — MUST be empty
    "correctionApplied": boolean                // false: the recommendation is grounded purely in the skill match
  }
}"""

# Few-shot examples use compact, illustrative skills (NOT real employee data) so the model
# learns the grounding discipline (a development step only for a MISSING skill; matched
# skills are never turned into steps; nothing is invented) and the exact output shape. Each
# input mirrors the MobilityRecommendRequest payload the user turn carries.
_FEW_SHOT = """<few_shot_examples>
  <example>
    <description>READY_SOON move: strong overlap, two missing skills become two development steps.</description>
    <input>{"targetRoleTitle":"Engineering Manager","requiredSkills":["People Management","System Design","Python","Stakeholder Communication"],"matchedSkills":["Python","System Design","Stakeholder Communication"],"missingSkills":["People Management"],"readiness":"READY_SOON","employeeContext":{"roleTitle":"Senior Engineer","level":"SENIOR","department":"Engineering"}}</input>
    <output>{"fitSummary":"This is a strong, logical next step: you already bring the technical depth (Python, System Design) and the stakeholder communication the Engineering Manager role needs. Building people-management skills would close the remaining gap. This is a suggestion to consider, not a decision.","developmentPlan":[{"skill":"People Management","action":"Take on a formal mentoring or tech-lead responsibility for a small group to practise coaching, feedback, and delivery ownership.","suggestedResource":"A first-time-manager fundamentals course or an internal leadership development program"}],"confidence":"high","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
  <example>
    <description>STRETCH move: several missing skills, each becomes one development step in order.</description>
    <input>{"targetRoleTitle":"Data Scientist","requiredSkills":["Python","Statistics","Machine Learning","SQL"],"matchedSkills":["Python","SQL"],"missingSkills":["Statistics","Machine Learning"],"readiness":"STRETCH","employeeContext":{"roleTitle":"Data Analyst","level":"MID","department":"Analytics"}}</input>
    <output>{"fitSummary":"This is a stretch move that builds naturally on your analytics foundation — your Python and SQL transfer directly. Growing your statistics and machine-learning skills would make this role attainable over time. Consider it as a development goal worth discussing.","developmentPlan":[{"skill":"Statistics","action":"Work through an applied statistics curriculum and apply hypothesis testing and regression to a current analytics project.","suggestedResource":"An applied statistics for data science course"},{"skill":"Machine Learning","action":"Complete a hands-on ML course and reproduce a model end-to-end on a real internal dataset under guidance.","suggestedResource":"An introductory machine-learning course or an internal ML guild project"}],"confidence":"medium","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
  <example>
    <description>READY_NOW move: no missing skills — empty development plan, no steps invented.</description>
    <input>{"targetRoleTitle":"Lead Product Designer","requiredSkills":["Interaction Design","Design Systems","User Research"],"matchedSkills":["Interaction Design","Design Systems","User Research"],"missingSkills":[],"readiness":"READY_NOW","employeeContext":{"roleTitle":"Senior Product Designer","level":"SENIOR","department":"Design"}}</input>
    <output>{"fitSummary":"You already hold every skill this Lead Product Designer role requires — you are ready now. This move is well worth raising in your next career conversation.","developmentPlan":[],"confidence":"high","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
</few_shot_examples>"""


def build_mobility_recommend_system_prompt(
    org_context: dict[str, object] | None = None,
) -> str:
    """XML-tagged system prompt for the move recommendation (standards #1/#2/#4/#5/#7).

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
  <role>Internal-mobility career coach inside an AI-native HR platform. You help an
    employee understand how an internal role fits them and what to develop to get there.</role>
  <context>
    - Organisation: {org_name} ({industry}).
    - You are given (a) a TARGET internal role title, (b) the skills that role REQUIRES,
      (c) the skills the employee ALREADY HAS that match the role (matchedSkills), (d) the
      skills the employee is still MISSING for the role (missingSkills), (e) a readiness
      tier (READY_NOW / READY_SOON / STRETCH) computed upstream from skill coverage, and
      (f) an optional NON-PII employee context (their current role/level/department).{custom_block}
    - This is advice for THIS employee only. You do not have access to any other employee.
  </context>
  <task_definition>
    Produce an internal move recommendation:
      1. fitSummary — 1-3 sentences explaining why this internal move fits the employee,
         naming a few of their matched skills as the foundation and framing the readiness
         tier honestly (a READY_NOW role is attainable now; a STRETCH role is a longer-term
         development goal). Always advisory — a suggestion to consider, never a decision.
      2. developmentPlan — EXACTLY ONE step per MISSING skill, in the order missingSkills
         lists them. For each: the missing ``skill`` (named exactly as given), a concrete,
         development-oriented ``action`` to build it, and an optional ``suggestedResource``
         (a concrete course / program; null when none clearly fits). If missingSkills is
         empty, developmentPlan MUST be an empty array.
      3. confidence and a biasCheck.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    - GROUND IN THE SUPPLIED SKILLS ONLY. The fitSummary may reference only skills in
      matchedSkills; the developmentPlan may contain a step ONLY for a skill in
      missingSkills. Never claim the employee holds a skill not in matchedSkills, never add
      a step for a skill not in missingSkills, and never invent a role requirement.
    - ONE development step per missing skill — no more, no fewer. If there are no missing
      skills, return an empty developmentPlan (do not invent growth areas).
    - Do NOT invent named internal courses/programs as if they were real — a
      suggestedResource must be either a plausibly generic suggestion (e.g. "an
      introductory <skill> course") or null; never fabricate a specific internal program.
    - Privacy (standard #7): reason only about THIS employee. Never reference, compare to,
      or name any other employee, real or hypothetical.
    - BIAS GUARD (standard #4): base the recommendation ONLY on the skill match and the
      target role. NEVER consider or mention any protected attribute (age, gender,
      ethnicity, national origin, disability, religion, marital/family status, etc.). Set
      biasCheck.biasIndicatorsDetected to [] and biasCheck.correctionApplied to false —
      the recommendation is computed purely from skills.
    - Keep it development-oriented and advisory: frame every action as growth the employee
      could pursue, never as a verdict on their suitability or a guarantee of selection.
    - confidence: "high" when the readiness is READY_NOW/READY_SOON and the gap is small
      and unambiguous; lower it for STRETCH moves or sparse/ambiguous inputs.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_mobility_recommend_user_prompt(
    *,
    target_role_title: str,
    required_skills: list[str],
    matched_skills: list[str],
    missing_skills: list[str],
    readiness: str,
    employee_context: dict[str, object] | None = None,
) -> str:
    """Assemble the user turn from the target role, the skill match, and the context."""
    payload = {
        "targetRoleTitle": target_role_title,
        "requiredSkills": required_skills,
        "matchedSkills": matched_skills,
        "missingSkills": missing_skills,
        "readiness": readiness,
        "employeeContext": employee_context or {},
    }
    blob = json.dumps(payload, default=str, sort_keys=True)
    return (
        "<mobility_recommend_input>\n"
        f"{blob}\n"
        "</mobility_recommend_input>\n\n"
        "Write the fitSummary and developmentPlan as a single JSON object. Include EXACTLY "
        "one development step per MISSING skill, grounded strictly in the matched/missing "
        "skills above."
    )


__all__ = [
    "PROMPT_VERSION",
    "build_mobility_recommend_system_prompt",
    "build_mobility_recommend_user_prompt",
]
