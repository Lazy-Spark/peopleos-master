"""Module 6a — Employee skill-graph "growth path" prompt.

Given an employee's current skills, a target role and the skills that role requires,
and (optionally) the org's skill catalog, the model recommends the missing skills that
would close the gap to the target role — each with a short ``why`` and a suggested
training resource (a concrete catalog match where one exists, else a generic but useful
suggestion). It also reports ``stepsAway`` — how many distinct required skills the
employee still lacks — and a ``biasCheck``.

Implements the 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role / context / task / output_schema / constraints / few-shot)
  #2 hallucination prevention — GROUND in the supplied skills ONLY: never claim the
     employee already has a skill they don't, never recommend a skill the role doesn't
     require, never reference another (real or invented) employee
  #3 (n/a — no chain-of-thought is returned; the answer is the JSON object)
  #4 bias guard — growth recommendations are based ONLY on the skill gap and the role;
     NEVER on any protected attribute (age, gender, ethnicity, disability, etc.).
     The model emits a ``biasCheck`` recording that no protected attribute influenced it.
  #5 exact output schema for Pydantic validation (with the shared retry / human-review path)
  #6 PROMPT_VERSION recorded on every output
  #7 privacy — reason only about THIS employee's own skills; never compare to or name
     any other employee.
Includes >= 2 few-shot examples.
"""

from __future__ import annotations

import json

PROMPT_VERSION = "module6.growth_path@1.0.0"

# Exact JSON schema the model must emit (camelCase, mirrors GrowthPathResponse minus the
# modelVersion/promptVersion fields, which this service stamps on).
_OUTPUT_SCHEMA = """{
  "summary": string,                          // 1-2 sentences, e.g. "You are 2 skills away from Senior ML Engineer."
  "stepsAway": integer,                       // count of targetRequiredSkills the employee LACKS (>= 0)
  "recommendedSkills": [                       // ONE entry per missing skill (in target-role order)
    {
      "skill": string,                        // the missing required skill, exactly as named in targetRequiredSkills
      "why": string,                          // short reason it matters for the target role
      "suggestedTraining": string | null      // a catalog match if one exists, else a generic suggestion, else null
    }
  ],
  "confidence": "low" | "medium" | "high",
  "biasCheck": {
    "biasIndicatorsDetected": string[],       // protected-attribute factors that influenced the rec — MUST be empty
    "correctionApplied": boolean              // false: growth is computed purely from the skill gap
  }
}"""

# Few-shot examples use compact, illustrative skills (NOT real employee data) so the model
# learns the grounding discipline (only missing required skills are recommended; held
# skills are never re-recommended; nothing is invented) and the exact output shape.
_FEW_SHOT = """<few_shot_examples>
  <example>
    <description>Two of the four required skills are missing; one has a catalog match, one does not.</description>
    <input>{"employeeSkills":[{"name":"Python","proficiency":"ADVANCED"},{"name":"Machine Learning","proficiency":"PRACTITIONER"}],"targetRoleTitle":"Senior ML Engineer","targetRequiredSkills":["Python","Machine Learning","MLOps","System Design"],"skillCatalog":["MLOps Fundamentals (internal course)","Kubernetes Basics"]}</input>
    <output>{"summary":"You are 2 skills away from Senior ML Engineer. Adding MLOps and System Design would qualify you.","stepsAway":2,"recommendedSkills":[{"skill":"MLOps","why":"Senior ML Engineers own model deployment and monitoring, so MLOps is required to ship and maintain models in production.","suggestedTraining":"MLOps Fundamentals (internal course)"},{"skill":"System Design","why":"The senior level expects you to design scalable ML systems end-to-end, not just train models.","suggestedTraining":"A system design fundamentals course or guided design-review practice"}],"confidence":"high","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
  <example>
    <description>Employee already holds every required skill — zero steps away, no recommendations.</description>
    <input>{"employeeSkills":[{"name":"SQL","proficiency":"EXPERT"},{"name":"Data Modeling","proficiency":"ADVANCED"},{"name":"dbt","proficiency":"PRACTITIONER"}],"targetRoleTitle":"Analytics Engineer","targetRequiredSkills":["SQL","Data Modeling","dbt"],"skillCatalog":[]}</input>
    <output>{"summary":"You already hold all 3 skills required for Analytics Engineer.","stepsAway":0,"recommendedSkills":[],"confidence":"high","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
  <example>
    <description>One missing skill, no catalog provided — a generic training suggestion is given.</description>
    <input>{"employeeSkills":[{"name":"Customer Discovery","proficiency":"ADVANCED"},{"name":"Roadmapping","proficiency":"PRACTITIONER"}],"targetRoleTitle":"Senior Product Manager","targetRequiredSkills":["Customer Discovery","Roadmapping","SQL"],"skillCatalog":[]}</input>
    <output>{"summary":"You are 1 skill away from Senior Product Manager: add SQL.","stepsAway":1,"recommendedSkills":[{"skill":"SQL","why":"Senior PMs are expected to self-serve product analytics, which requires querying data directly with SQL.","suggestedTraining":"An introductory SQL for product analytics course"}],"confidence":"high","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}}</output>
  </example>
</few_shot_examples>"""


def build_growth_path_system_prompt(org_context: dict[str, object] | None = None) -> str:
    """XML-tagged system prompt for the growth path (prompt standards #1/#2/#4/#5/#7).

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
  <role>Career-development coach inside an AI-native HR platform. You build an employee a
    concrete, skills-based growth path toward a target role.</role>
  <context>
    - Organisation: {org_name} ({industry}).
    - You are given (a) the employee's CURRENT skills with proficiency, (b) a TARGET role
      title, (c) the skills that role REQUIRES, and (d) an optional org skill catalog of
      available trainings.{custom_block}
    - This is advice for THIS employee only. You do not have access to any other employee.
  </context>
  <task_definition>
    Produce a growth path to the target role:
      1. stepsAway — the number of DISTINCT required skills the employee does NOT yet have
         (case-insensitive name match against the employee's current skills).
      2. recommendedSkills — one entry per missing required skill (in the order the skills
         appear in targetRequiredSkills). For each: a short ``why`` (why that skill matters
         for the target role) and a ``suggestedTraining``. Prefer a concrete item from the
         skill catalog whose name clearly covers the skill; if nothing in the catalog fits,
         give a generic but useful suggestion (e.g. "an introductory <skill> course"); use
         null only when no sensible suggestion exists.
      3. summary — 1-2 sentences naming how many steps away and which skills to add
         (e.g. "You are 2 skills away from Senior ML Engineer. Add MLOps and System Design.").
      4. confidence and a biasCheck.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    - GROUND IN THE SUPPLIED SKILLS ONLY. Never claim the employee already holds a skill
      that is not in their current-skills list, and never recommend a skill that is not in
      targetRequiredSkills. stepsAway MUST equal the count of recommendedSkills.
    - Never re-recommend a skill the employee already holds (it is not a gap).
    - Do NOT invent trainings that are not in the catalog as if they were real internal
      courses — a catalog suggestion must come from the provided catalog; otherwise keep
      the suggestion clearly generic.
    - Privacy (standard #7): reason only about THIS employee. Never reference, compare to,
      or name any other employee, real or hypothetical.
    - BIAS GUARD (standard #4): base the growth path ONLY on the skill gap and the target
      role. NEVER consider or mention any protected attribute (age, gender, ethnicity,
      national origin, disability, religion, marital/family status, etc.). Set
      biasCheck.biasIndicatorsDetected to [] and biasCheck.correctionApplied to false —
      the path is computed purely from skills.
    - confidence: "high" when the required-skills list is clear and the gap is unambiguous;
      lower it only if the inputs are sparse or ambiguous.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_growth_path_user_prompt(
    *,
    employee_skills: list[dict[str, object]],
    target_role_title: str,
    target_required_skills: list[str],
    skill_catalog: list[str],
) -> str:
    """Assemble the user turn from the employee's skills, the target role, and the catalog."""
    payload = {
        "employeeSkills": employee_skills,
        "targetRoleTitle": target_role_title,
        "targetRequiredSkills": target_required_skills,
        "skillCatalog": skill_catalog,
    }
    blob = json.dumps(payload, default=str, sort_keys=True)
    return (
        "<growth_path_input>\n"
        f"{blob}\n"
        "</growth_path_input>\n\n"
        "Build the growth path as a single JSON object. Recommend ONLY required skills the "
        "employee is missing, grounded strictly in the skills above."
    )
