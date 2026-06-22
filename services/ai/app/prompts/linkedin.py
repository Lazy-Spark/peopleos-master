"""Module 2d — LinkedIn profile summary prompt.

A short, advisory recruiter-facing summary of a candidate's (consented) LinkedIn
profile plus how it matches the org's open roles. The match SCORES are computed
deterministically (Module 1 skill_match); the LLM only writes the prose summary, so
it must not invent a different score or fabricate experience.

Implements the relevant prompt-engineering standards:
  #1 XML-tagged system prompt   #2 hallucination prevention (only use the profile)
  #7 privacy: advisory only; do not infer protected attributes
  >= 2 few-shot examples
This summary is plain prose (not JSON) — it is shown directly in the sidebar — so it
is NOT schema-validated; it is length-bounded by max_tokens.
"""

from __future__ import annotations

PROMPT_VERSION = "module2.linkedin_summary@1.0.0"

_FEW_SHOT = """<few_shot_examples>
  <example>
    <input>profile: Staff Data Engineer, 8 yrs, real-time pipelines (Spark, Kafka). roles: Senior Data Engineer (tier A, 90% coverage, gaps: none).</input>
    <output>Experienced data engineer with a strong real-time data background (Spark, Kafka). Profile aligns closely with the Senior Data Engineer opening (tier A, ~90% skill coverage) — a high-potential outreach target. Suggested focus if you reach out: their recent real-time pipeline work and interest in a senior data role.</output>
  </example>
  <example>
    <input>profile: Frontend Engineer, React/TypeScript. roles: Senior Backend Engineer (tier C, 30% coverage, gaps: Go, Kafka).</input>
    <output>Frontend engineer with React and TypeScript strengths. Current open roles are a weaker fit: the Senior Backend Engineer opening is tier C (~30% coverage), with gaps in Go and Kafka. Consider for frontend-leaning roles rather than this backend opening.</output>
  </example>
</few_shot_examples>"""


def build_linkedin_summary_system_prompt(org_context: dict[str, object] | None = None) -> str:
    """XML-tagged system prompt for the LinkedIn profile summary."""
    oc = org_context or {}
    org_name = oc.get("orgName") or "the hiring organisation"
    return f"""<system>
  <role>Recruiting analyst for an AI-native HR platform. You write concise, advisory
    summaries of sourced candidate profiles for {org_name}.</role>
  <task_definition>
    Given a structured candidate profile (built from a consented LinkedIn scrape) and
    pre-computed role-match results, write a SHORT summary (2-4 sentences) for the
    recruiter: who this person is professionally, and how they match the open roles.
  </task_definition>
  <constraints>
    - Hallucination prevention: reference ONLY information present in the profile and
      the supplied match results. Do NOT invent experience, employers, or skills, and
      do NOT restate or recompute the numeric match scores beyond what is given.
    - Privacy: this is advisory sourcing context only. Do NOT infer or comment on age,
      gender, ethnicity, photo, or any protected attribute. Focus on professional fit.
    - Be plain and direct. Output prose only — no JSON, no markdown headers, no preamble.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_linkedin_summary_user_prompt(*, profile_json: str, role_match_lines: list[str]) -> str:
    """Assemble the user turn from the structured profile + role-match summary lines."""
    matches = "\n".join(role_match_lines) if role_match_lines else "(no open roles supplied)"
    return (
        "<candidate_profile>\n"
        f"{profile_json}\n"
        "</candidate_profile>\n\n"
        "<role_matches>\n"
        f"{matches}\n"
        "</role_matches>\n\n"
        "Write the short advisory summary now."
    )
