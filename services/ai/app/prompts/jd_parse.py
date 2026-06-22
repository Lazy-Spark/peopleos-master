"""Module 1 step 1 — structured JD parsing prompt.

Extracts ``JDStructured`` (job.ts) from free-text. Per spec this uses structured
extraction (tool_use / strict JSON), NOT free-form text. We instruct the model to
return ONLY a JSON object matching the schema so it can be Pydantic-validated.

Follows the 7 prompt-engineering standards:
  #1 XML-tagged system prompt   #2 no inventing data (null when absent)
  #5 exact output schema for validation
Includes >= 2 few-shot examples.
"""

from __future__ import annotations

PROMPT_VERSION = "module1.jd_parse@1.0.0"

# Exact JSON schema the model must emit (camelCase, matches JDStructured).
_OUTPUT_SCHEMA = """{
  "requiredSkills": [{ "canonicalName": string, "importance": "CRITICAL" | "PREFERRED" }],
  "preferredSkills": string[],
  "requiredYoe": number | null,
  "niceToHaveYoe": number | null,
  "roleLevel": "INTERN"|"JUNIOR"|"MID"|"SENIOR"|"STAFF"|"PRINCIPAL"|"MANAGER"|"DIRECTOR"|"VP"|"EXEC" | null,
  "keyResponsibilities": string[],
  "teamContext": string | null,
  "reportingStructure": string | null
}"""

_FEW_SHOT = """<few_shot_examples>
  <example>
    <input>
Senior Backend Engineer. You will design and operate our payments platform in Go,
build event-driven services on Kafka, and mentor two mid-level engineers. 5+ years
backend experience required; Kubernetes a plus. Reports to the Engineering Manager,
Platform team.
    </input>
    <output>{"requiredSkills":[{"canonicalName":"Go","importance":"CRITICAL"},{"canonicalName":"Kafka","importance":"CRITICAL"}],"preferredSkills":["Kubernetes"],"requiredYoe":5,"niceToHaveYoe":null,"roleLevel":"SENIOR","keyResponsibilities":["Design and operate the payments platform","Build event-driven services on Kafka","Mentor two mid-level engineers"],"teamContext":"Platform team","reportingStructure":"Reports to the Engineering Manager"}</output>
  </example>
  <example>
    <input>
Marketing Coordinator (entry level). Support campaign execution, schedule social
posts, and compile weekly performance reports. Familiarity with Canva and Google
Analytics welcome. No prior experience required.
    </input>
    <output>{"requiredSkills":[],"preferredSkills":["Canva","Google Analytics"],"requiredYoe":0,"niceToHaveYoe":null,"roleLevel":"JUNIOR","keyResponsibilities":["Support campaign execution","Schedule social posts","Compile weekly performance reports"],"teamContext":null,"reportingStructure":null}</output>
  </example>
</few_shot_examples>"""


def build_jd_parse_system_prompt(org_context: dict[str, object] | None = None) -> str:
    """The XML-tagged system prompt for JD structured extraction.

    ``org_context`` (optional) personalises the <context> block (prompt standard #1).
    """
    oc = org_context or {}
    org_name = oc.get("orgName") or "the hiring organisation"
    industry = oc.get("industry") or "unspecified industry"
    return f"""<system>
  <role>Senior technical recruiting analyst for an AI-native HR platform.</role>
  <context>
    - Organisation: {org_name} ({industry}). You are turning a free-text job
      description into structured data a recruiter will review; be faithful to the
      source text and never editorialise.
  </context>
  <task_definition>
    Read the job description in the user message and extract a single structured
    JSON object describing the role. Classify each required skill as CRITICAL
    (must-have) or PREFERRED. Map seniority phrasing to the closest roleLevel.
    Use structured extraction only — output JSON, never prose.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    - Never invent requirements that are not stated. If a field is not present,
      use null (scalars) or [] (arrays).
    - canonicalName values must be concise canonical skill names (e.g. "React",
      not "experience with React.js").
    - requiredYoe: extract the minimum years explicitly required; null if none.
    - Do not infer roleLevel from compensation or perceived prestige; only from
      seniority/title language. null if genuinely ambiguous.
    - This output is advisory input to a downstream ranker; be precise, not creative.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_jd_parse_user_prompt(jd_text: str) -> str:
    """Wrap the raw JD text for the user turn."""
    return f"<job_description>\n{jd_text.strip()}\n</job_description>\n\nReturn only the JSON object."
