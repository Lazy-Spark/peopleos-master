"""Module 2b — Candidate Outreach Generator prompt.

The model receives a candidate's CONCRETE profile (NOT bias-masked — this message is
addressed to the real person, so it must reference real resume details to feel human;
see the bias note in copilot.ts / GenerateOutreachRequest), the job context, the
recruiter's name, and the requested tones. It returns one variant per requested tone
plus an InMail body and extra subject-line variants for A/B testing.

Implements the 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role/context/task/output_schema/constraints/few-shot)
  #2 hallucination prevention: only reference details that exist in the profile
  #5 exact output schema for Pydantic validation
  #6 PROMPT_VERSION recorded on the output
  >= 2 few-shot examples

NOTE ON BIAS: outreach is intentionally personalised to the real candidate, so the
profile is NOT masked here (unlike Module 1 scoring). The output still carries a
biasCheck so any inadvertently non-inclusive phrasing is recorded.
"""

from __future__ import annotations

PROMPT_VERSION = "module2.outreach@1.0.0"

# Exact JSON schema the model must emit (camelCase). ``variants`` carries one object
# per requested tone; ``subjectVariants`` are extra subject lines for A/B testing.
_OUTPUT_SCHEMA = """{
  "variants": [{ "tone": "WARM" | "FORMAL" | "BRIEF", "subject": string, "body": string }],
  "inMail": { "subject": string | null, "body": string },
  "subjectVariants": string[]
}"""

_FEW_SHOT = """<few_shot_examples>
  <example>
    <description>Warm + brief variants referencing a concrete project; recruiter "Maya".</description>
    <input>candidate: Priya Nair, headline "Staff Data Engineer", recent role: built a real-time fraud pipeline on Spark at FinShield. job: Senior Data Engineer at Northwind. recruiter: Maya. tones: WARM, BRIEF.</input>
    <output>{"variants":[{"tone":"WARM","subject":"Your real-time fraud work caught my eye, Priya","body":"Hi Priya,\\n\\nYour work building the real-time fraud pipeline on Spark at FinShield really stood out to me. We're growing the data platform team at Northwind and I think the Senior Data Engineer role could be a great fit for what you do best.\\n\\nWould you be open to a quick 20-minute chat this week?\\n\\nBest,\\nMaya"},{"tone":"BRIEF","subject":"Senior Data Engineer @ Northwind","body":"Hi Priya — your real-time fraud pipeline work at FinShield is exactly the kind of experience we're looking for in our Senior Data Engineer role at Northwind. Open to a short chat?\\n\\nMaya"}],"inMail":{"subject":"Senior Data Engineer role at Northwind","body":"Hi Priya, I came across your profile and your real-time fraud pipeline work at FinShield stood out. We're hiring a Senior Data Engineer at Northwind and I'd love to tell you more. Would you be open to connecting?\\n\\nMaya"},"subjectVariants":["A data platform role built for your strengths","Northwind is hiring a Senior Data Engineer","Loved your fraud-detection work, Priya"]}</output>
  </example>
  <example>
    <description>Formal variant; sparse profile — references only what exists, no invention.</description>
    <input>candidate: name unknown, headline "Backend Engineer". job: Backend Engineer at Acme. recruiter: Sam. tones: FORMAL.</input>
    <output>{"variants":[{"tone":"FORMAL","subject":"Backend Engineer opportunity at Acme","body":"Hello,\\n\\nI am reaching out regarding a Backend Engineer position at Acme. Based on your background as a backend engineer, I believe this role may align well with your experience.\\n\\nIf you are open to it, I would welcome the chance to share more details at a time that suits you.\\n\\nKind regards,\\nSam"}],"inMail":{"subject":"Backend Engineer opportunity at Acme","body":"Hello, I'm reaching out about a Backend Engineer role at Acme that may align with your background. Would you be open to a brief conversation?\\n\\nSam"},"subjectVariants":["An opportunity that fits your backend background","Backend Engineer role at Acme"]}</output>
  </example>
</few_shot_examples>"""


def build_outreach_system_prompt(org_context: dict[str, object] | None = None) -> str:
    """XML-tagged system prompt for outreach generation (prompt standards #1/#2/#5)."""
    oc = org_context or {}
    org_name = oc.get("orgName") or "the hiring organisation"
    industry = oc.get("industry") or "unspecified industry"
    tone = oc.get("tonePreferences") or "warm, professional, human"
    rules = oc.get("customRules") or []
    rules_txt = "; ".join(str(r) for r in rules) if rules else "none"
    return f"""<system>
  <role>Expert technical recruiter writing first-touch candidate outreach for an
    AI-native HR platform. You write messages that feel personal and human, never
    like mass spam.</role>
  <context>
    - Organisation: {org_name} ({industry}). House tone preferences: {tone}.
    - Org-specific rules: {rules_txt}.
    - This message is sent to a REAL named candidate. Personalise it to concrete
      details from their profile so it feels genuinely human.
  </context>
  <task_definition>
    Write candidate outreach for the supplied role. Produce ONE variant per requested
    tone (WARM = friendly and personable; FORMAL = polished and professional;
    BRIEF = short and to the point). Also write a LinkedIn InMail body and a list of
    additional subject-line options for A/B testing. Reference at least one concrete,
    real detail from the candidate's profile (a project, employer, or skill).
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
    Produce exactly one entry in "variants" for each tone listed in the user message,
    in that order.
  </output_schema>
  <constraints>
    - Hallucination prevention: reference ONLY details that appear in the candidate
      profile. NEVER invent projects, employers, achievements, or personal facts. If
      the profile is sparse, keep the personalisation light and honest rather than
      fabricating.
    - Address the candidate by their first name if it is present; otherwise open
      neutrally (e.g. "Hello").
    - Always sign off as the recruiter named in the user message.
    - Keep BRIEF bodies under ~60 words; WARM/FORMAL under ~120 words.
    - Use inclusive, respectful language. No pressure tactics, no false urgency, no
      compensation promises that were not provided.
    - Do not reference age, gender, ethnicity, photos, or anything not relevant to the
      candidate's professional fit.
  </constraints>
  {_FEW_SHOT}
</system>"""


def _profile_brief(profile_json: str) -> str:
    """Wrap the (unmasked) candidate profile JSON for the user turn."""
    return f"<candidate_profile>\n{profile_json}\n</candidate_profile>"


def build_outreach_user_prompt(
    *,
    profile_json: str,
    job_title: str,
    job_summary: str | None,
    recruiter_name: str,
    tones: list[str],
) -> str:
    """Assemble the user turn from the profile, job context, recruiter, and tones."""
    job_block = f"<job>\n  title: {job_title}\n"
    if job_summary:
        job_block += f"  summary: {job_summary}\n"
    job_block += "</job>"
    tones_csv = ", ".join(tones)
    return (
        f"{_profile_brief(profile_json)}\n\n"
        f"{job_block}\n\n"
        f"<recruiter>{recruiter_name}</recruiter>\n"
        f"<requested_tones>{tones_csv}</requested_tones>\n\n"
        "Write the outreach. Return only the JSON object matching the schema, with one "
        "variant per requested tone in the order listed."
    )
