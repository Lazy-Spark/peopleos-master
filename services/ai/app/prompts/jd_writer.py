"""Module 2a — Job Description Writer prompt.

The model receives a role brief (title, seniority, team context, hiring-manager
notes) + optional ``orgContext`` (tone) + the org's prior JD texts (tone-matched
few-shot, retrieved from the vector store by the API). It returns a structured
``GeneratedJobDescription``-shaped JSON object (summary / responsibilities /
requirements / preferred / benefits / deiStatement) which we then assemble into
``jdText`` and run an inclusive-language pass over (see app/copilot/jd_writer.py).

Implements all 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role/context/task/output_schema/constraints/few-shot)
  #2 hallucination prevention: never invent comp/benefits not supplied; mark TBD
  #4 BIAS prevention: gender-neutral, avoid masculine-coded / exclusionary phrasing
  #5 exact output schema for Pydantic validation
  #6 PROMPT_VERSION recorded on every output (promptVersion field)
  >= 2 few-shot examples (tone-matched org examples are appended dynamically too)
"""

from __future__ import annotations

PROMPT_VERSION = "module2.jd_writer@1.0.0"

# Exact JSON schema the model must emit (camelCase). We deliberately ask ONLY for the
# content sections; jdText is assembled deterministically and the inclusive-language
# report + biasCheck are produced by a separate pass (so the model cannot fabricate a
# clean bias report for its own copy).
_OUTPUT_SCHEMA = """{
  "title": string,
  "summary": string,
  "responsibilities": string[],
  "requirements": string[],
  "preferred": string[],
  "benefits": string[],
  "deiStatement": string
}"""

# Two static few-shot exemplars (the org's own prior JDs are appended at build time).
_FEW_SHOT = """<few_shot_examples>
  <example>
    <description>Senior engineering role, warm/collaborative tone, inclusive language.</description>
    <input>roleTitle: Senior Backend Engineer; seniority: SENIOR; team: Payments Platform; notes: owns Go + Kafka services, mentors two mids, 5+ yrs.</input>
    <output>{"title":"Senior Backend Engineer","summary":"Join our Payments Platform team to design and operate the services that move money safely at scale. You will own critical backend systems and help two mid-level engineers grow.","responsibilities":["Design, build, and operate event-driven payment services in Go and Kafka","Partner with product and platform teams on reliability and throughput","Mentor and support the growth of two mid-level engineers","Improve observability, testing, and on-call practices"],"requirements":["5+ years building and operating backend services in production","Strong experience with Go and event-driven architectures (e.g. Kafka)","A collaborative approach to design reviews and code reviews"],"preferred":["Experience with Kubernetes","Exposure to payments or other regulated domains"],"benefits":["Competitive salary and equity","Flexible/remote-friendly working","Generous paid time off and parental leave","Learning and development budget"],"deiStatement":"We welcome applicants of all backgrounds and are committed to building an inclusive team. We encourage you to apply even if you do not meet every requirement listed."}</output>
  </example>
  <example>
    <description>Entry-level non-technical role; clear, accessible language; no jargon.</description>
    <input>roleTitle: Marketing Coordinator; seniority: JUNIOR; team: Growth; notes: support campaigns, schedule social posts, weekly reports; no prior experience required.</input>
    <output>{"title":"Marketing Coordinator","summary":"We are looking for an organised and curious Marketing Coordinator to support our Growth team in delivering campaigns that reach the right people at the right time.","responsibilities":["Support the planning and execution of marketing campaigns","Schedule and publish social media posts","Compile clear weekly performance reports","Coordinate with designers and writers to keep work on track"],"requirements":["Strong written and verbal communication","Comfort working with spreadsheets and basic analytics","An organised, detail-oriented approach"],"preferred":["Familiarity with tools like Canva or Google Analytics"],"benefits":["Competitive salary","Flexible working","Paid time off","Mentorship and on-the-job training"],"deiStatement":"We are an equal-opportunity employer and value diversity. We provide reasonable accommodations throughout the hiring process — please let us know what you need."}</output>
  </example>
</few_shot_examples>"""


def _prior_jd_block(prior_jd_examples: list[str], max_examples: int = 3) -> str:
    """Tone-matched few-shot from the org's OWN prior JDs (spec 2a, standard #1).

    The API retrieves these from the org's JD vector store; we inline up to
    ``max_examples`` so the model matches the house writing style. Each example is
    lightly truncated to keep the prompt within budget.
    """
    examples = [e.strip() for e in prior_jd_examples if e and e.strip()][:max_examples]
    if not examples:
        return ""
    blocks: list[str] = []
    for i, ex in enumerate(examples, start=1):
        snippet = ex[:1500]
        blocks.append(f"  <prior_jd index=\"{i}\">\n{snippet}\n  </prior_jd>")
    joined = "\n".join(blocks)
    return (
        "\n<org_prior_jds>\n"
        "  These are the organisation's own prior job descriptions. MATCH their tone,\n"
        "  structure, and house style (do NOT copy their role-specific content):\n"
        f"{joined}\n"
        "</org_prior_jds>"
    )


def build_jd_writer_system_prompt(
    *,
    org_context: dict[str, object] | None = None,
    prior_jd_examples: list[str] | None = None,
) -> str:
    """XML-tagged system prompt for JD generation (prompt standards #1/#2/#4/#5)."""
    oc = org_context or {}
    org_name = oc.get("orgName") or "the hiring organisation"
    industry = oc.get("industry") or "unspecified industry"
    headcount = oc.get("headcount")
    size = f"~{headcount} employees" if headcount else "unspecified size"
    user_role = oc.get("userRole") or "RECRUITER"
    tone = oc.get("tonePreferences") or "warm, professional, inclusive"
    rules = oc.get("customRules") or []
    rules_txt = "; ".join(str(r) for r in rules) if rules else "none"
    prior_block = _prior_jd_block(prior_jd_examples or [])
    return f"""<system>
  <role>Senior recruiting copywriter for an AI-native HR platform. You write
    compelling, accurate, and inclusive job descriptions.</role>
  <context>
    - Organisation: {org_name} ({industry}, {size}).
    - Requesting user role: {user_role} — write copy they can publish with light edits.
    - House tone preferences: {tone}. Org-specific rules: {rules_txt}.
  </context>
  <task_definition>
    Using the role brief in the user message, write a complete job description split
    into: a short summary, responsibilities, requirements (must-haves), preferred
    (nice-to-haves), benefits, and a DEI statement. Be specific and grounded in the
    brief; prefer concrete responsibilities over generic filler.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
  </output_schema>
  <constraints>
    <bias>
      Use gender-neutral language throughout. AVOID masculine-coded words
      (e.g. rockstar, ninja, dominant, aggressive, competitive-by-default) and
      exclusionary phrasing (e.g. "young and energetic", "native English speaker",
      "able-bodied", "digital native"). Prefer inclusive alternatives
      (collaborative, impactful, skilled, motivated). Keep requirements to what the
      role genuinely needs so you do not deter qualified candidates.
    </bias>
    - Hallucination prevention: never invent specific salary figures, equity amounts,
      named benefits, or locations that are not in the brief. If compensation is not
      provided, describe benefits generically (e.g. "competitive salary") and do not
      fabricate numbers.
    - The deiStatement must be a genuine equal-opportunity / inclusion statement and
      must invite candidates who may not meet every listed requirement to still apply.
    - requirements should be true must-haves; move stretch items into preferred.
    - Write in clear, accessible language; avoid unexplained internal jargon.
  </constraints>
  {_FEW_SHOT}{prior_block}
</system>"""


def build_jd_writer_user_prompt(
    *,
    role_title: str,
    seniority: str | None,
    department: str | None,
    team_context: str | None,
    hiring_manager_notes: str | None,
) -> str:
    """Assemble the user turn from the role brief."""
    lines = [f"roleTitle: {role_title}"]
    if seniority:
        lines.append(f"seniority: {seniority}")
    if department:
        lines.append(f"department: {department}")
    if team_context:
        lines.append(f"teamContext: {team_context}")
    if hiring_manager_notes:
        lines.append(f"hiringManagerNotes: {hiring_manager_notes}")
    brief = "\n".join(lines)
    return (
        "<role_brief>\n"
        f"{brief}\n"
        "</role_brief>\n\n"
        "Write the job description. Return only the JSON object matching the schema."
    )
