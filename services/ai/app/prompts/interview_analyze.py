"""Module 3 — Interview Intelligence analysis prompt.

The model receives a CONFIDENTIAL, diarised interview transcript, the role's
scorecard template (the competencies to score), the job title, and optional org
context. In ONE coherent pass it produces all four spec steps:

  step 1  competency extraction  -> CompetencyEvidence[] (per detected Q/A: question,
          answerSummary, behaviouralIndicators[], competencyArea, STAR per-dimension
          situation/task/action/result in [0,1], starCompleteness)
  step 2  structured scorecard   -> one CompetencyScore (1-5) per template competency,
          EACH with a VERBATIM evidenceQuote from the transcript + rationale; plus an
          overall recommendation (STRONG_YES/YES/NO/STRONG_NO) + confidence + keyReasons
  step 3  executive summary      -> a 3-paragraph summary (background recap /
          performance highlights / concerns + next steps)
  step 4  calibration flags      -> LEADING_QUESTION + ILLEGAL_QUESTION flags grounded
          in a transcript quote (panel SCORE_DIVERGENCE is computed by the API, not here)

Implements the 7 prompt-engineering standards:
  #1 XML-tagged system prompt (role/context/task/output_schema/constraints/few-shot)
  #2 hallucination prevention: NO competency score without a verbatim transcript quote;
     only reference what the transcript actually contains
  #4 bias prevention: a biasCheck field is required in the output
  #5 exact output schema for Pydantic validation (+ retry path in validation.py)
  #6 PROMPT_VERSION recorded on the output
  #7 PRIVACY GUARD: evaluate ONLY professional competencies; disregard and NEVER repeat
     personal disclosures (health, family, religion, age, etc.) the candidate volunteers
  >= 2 few-shot examples

PRIVACY: the transcript is highly sensitive. The system prompt explicitly forbids the
model from repeating personal disclosures in any output field. Off-limits interviewer
questions are flagged (step 4) WITHOUT echoing the candidate's protected answer.
"""

from __future__ import annotations

PROMPT_VERSION = "module3.interview_analyze@1.0.0"

# Exact JSON schema the model must emit (camelCase). Mirrors AnalyzeInterviewResponse
# minus the server-attached modelVersion/promptVersion fields. STAR dimensions and
# starCompleteness are floats in [0,1]; competency score is an integer 1-5.
_OUTPUT_SCHEMA = """{
  "competencyEvidence": [
    {
      "question": string,
      "answerSummary": string,
      "behaviouralIndicators": string[],
      "competencyArea": string,
      "star": { "situation": number, "task": number, "action": number, "result": number },
      "starCompleteness": number
    }
  ],
  "scorecardDraft": {
    "competencyScores": [
      {
        "competencyId": string,
        "competencyName": string,
        "score": 1 | 2 | 3 | 4 | 5,
        "evidenceQuote": string,
        "rationale": string
      }
    ],
    "overallRecommendation": "STRONG_YES" | "YES" | "NO" | "STRONG_NO",
    "confidence": "low" | "medium" | "high",
    "keyReasons": string[],
    "summary": string,
    "biasCheck": { "biasIndicatorsDetected": string[], "correctionApplied": boolean }
  },
  "calibrationFlags": [
    {
      "type": "LEADING_QUESTION" | "ILLEGAL_QUESTION",
      "severity": "LOW" | "MEDIUM" | "HIGH",
      "detail": string,
      "evidenceQuote": string | null,
      "illegalTopic": "PREGNANCY" | "FAMILY_PLANNING" | "RELIGION" | "AGE" | "NATIONALITY" | "MARITAL_STATUS" | "HEALTH_DISABILITY" | "RACE" | "SEXUAL_ORIENTATION" | "OTHER" | null,
      "competencyId": string | null
    }
  ]
}"""

# >= 2 few-shot examples. The first shows a clean answer scored WITH a verbatim quote
# and an off-limits interviewer question flagged WITHOUT echoing the protected answer.
# The second shows a leading question + a thin STAR answer + a privacy disclosure the
# model must NOT repeat in any field.
_FEW_SHOT = """<few_shot_examples>
  <example>
    <description>Strong answer scored with a verbatim evidence quote; interviewer asks an
      off-limits question (children) which is flagged as ILLEGAL_QUESTION/FAMILY_PLANNING
      WITHOUT repeating the candidate's protected answer in any output field.</description>
    <input>job: Senior Backend Engineer. competencies: [{"competencyId":"c_sys","name":"System Design"},{"competencyId":"c_own","name":"Ownership"}].
transcript:
Interviewer A: Tell me about a time you scaled a service under load.
Candidate: At Northwind our checkout API was timing out at peak. I owned the fix end to end. I profiled it, found an N+1 query, added Redis caching and a read replica, and we cut p99 latency from 1.2s to 180ms with zero downtime.
Interviewer A: Do you have any kids at home that might affect on-call?
Candidate: [personal answer]</input>
    <output>{"competencyEvidence":[{"question":"Tell me about a time you scaled a service under load.","answerSummary":"Owned an end-to-end fix for a timing-out checkout API: profiled it, removed an N+1 query, added Redis caching and a read replica, cutting p99 latency from 1.2s to 180ms with no downtime.","behaviouralIndicators":["End-to-end ownership","Root-cause profiling","Quantified impact (p99 1.2s -> 180ms)"],"competencyArea":"System Design","star":{"situation":0.9,"task":0.8,"action":0.95,"result":0.95},"starCompleteness":0.9}],"scorecardDraft":{"competencyScores":[{"competencyId":"c_sys","competencyName":"System Design","score":5,"evidenceQuote":"I profiled it, found an N+1 query, added Redis caching and a read replica, and we cut p99 latency from 1.2s to 180ms with zero downtime.","rationale":"Concrete, well-structured systems work with a clear bottleneck diagnosis and a quantified latency result."},{"competencyId":"c_own","competencyName":"Ownership","score":5,"evidenceQuote":"I owned the fix end to end.","rationale":"Explicit end-to-end ownership of the problem from diagnosis through to the measured outcome."}],"overallRecommendation":"STRONG_YES","confidence":"high","keyReasons":["Strong, quantified system-design example","Clear end-to-end ownership"],"summary":"The candidate interviewed for a Senior Backend Engineer role and walked through a production scaling problem at a prior employer.\\n\\nThey demonstrated strong system-design and ownership: diagnosing an N+1 query, introducing caching and a read replica, and delivering a quantified p99 latency improvement with no downtime.\\n\\nNo competency concerns were raised in this segment; recommended next step is a system-design deep dive to confirm depth at greater scale.","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}},"calibrationFlags":[{"type":"ILLEGAL_QUESTION","severity":"HIGH","detail":"The interviewer asked about the candidate's children, an off-limits family-planning topic that must not influence the hiring decision. Re-train the panel on lawful interviewing.","evidenceQuote":"Do you have any kids at home that might affect on-call?","illegalTopic":"FAMILY_PLANNING","competencyId":null}]}</output>
  </example>
  <example>
    <description>Leading question by the interviewer; a thin STAR answer scored 2/5 with a
      verbatim quote; the candidate volunteers a health disclosure that must NOT appear
      anywhere in the output (privacy guard).</description>
    <input>job: Product Manager. competencies: [{"competencyId":"c_comm","name":"Communication"}].
transcript:
Interviewer B: You'd agree that stakeholder alignment is the most important PM skill, right?
Candidate: Um, yeah I guess so. I usually just send a weekly email. By the way I've been managing a chronic illness so my notes can be brief.</input>
    <output>{"competencyEvidence":[{"question":"You'd agree that stakeholder alignment is the most important PM skill, right?","answerSummary":"Agreed with the premise and described keeping stakeholders aligned via a weekly email update.","behaviouralIndicators":["Uses a recurring written update"],"competencyArea":"Communication","star":{"situation":0.2,"task":0.2,"action":0.3,"result":0.1},"starCompleteness":0.2}],"scorecardDraft":{"competencyScores":[{"competencyId":"c_comm","competencyName":"Communication","score":2,"evidenceQuote":"I usually just send a weekly email.","rationale":"Communication approach is minimal and generic with no concrete example, audience tailoring, or outcome; STAR structure is largely absent."}],"overallRecommendation":"NO","confidence":"medium","keyReasons":["Communication answer was thin and unstructured","No concrete stakeholder-alignment example given"],"summary":"The candidate interviewed for a Product Manager role and was asked about stakeholder alignment.\\n\\nThe response was brief and generic, citing a weekly email as the main mechanism without a concrete situation, action, or measurable result.\\n\\nThe communication signal is weak from this segment; a follow-up behavioural interview with a structured prompt is recommended before any decision.","biasCheck":{"biasIndicatorsDetected":[],"correctionApplied":false}},"calibrationFlags":[{"type":"LEADING_QUESTION","severity":"MEDIUM","detail":"The interviewer framed the question to invite agreement ('you'd agree ... right?'), which biases the candidate's answer and reduces its evidential value. Encourage neutral, open phrasing.","evidenceQuote":"You'd agree that stakeholder alignment is the most important PM skill, right?","illegalTopic":null,"competencyId":"c_comm"}]}</output>
  </example>
</few_shot_examples>"""


def build_analyze_system_prompt(
    *,
    job_title: str | None,
    org_context: dict[str, object] | None = None,
) -> str:
    """XML-tagged system prompt for interview analysis (prompt standards #1/#2/#4/#5/#7).

    The privacy guard (standard #7) and the no-score-without-evidence rule (standard #2)
    are stated as hard constraints; ``biasCheck`` is required in the output (standard #4).
    """
    oc = org_context or {}
    org_name = oc.get("orgName") or "the hiring organisation"
    industry = oc.get("industry") or "unspecified industry"
    role = job_title or "the role being interviewed for"
    rules = oc.get("customRules") or []
    rules_txt = "; ".join(str(r) for r in rules) if rules else "none"
    return f"""<system>
  <role>Senior HR interview-intelligence analyst for {org_name}. You analyse a
    confidential interview transcript and produce a structured, evidence-grounded
    scorecard draft. You are ADVISORY only — you never make the hiring decision.</role>
  <context>
    - Organisation: {org_name} ({industry}).
    - Role under interview: {role}.
    - Org-specific rules: {rules_txt}.
    - The transcript is diarised (speaker labels distinguish interviewer(s) from the
      candidate). Score the CANDIDATE's answers; assess the INTERVIEWER's questions only
      for calibration flags (leading / off-limits questions).
  </context>
  <task_definition>
    Perform four steps in one pass and return a single JSON object:
    1. Competency extraction: for each distinct interview question + candidate answer,
       emit a competencyEvidence entry with a one-line answerSummary, concrete
       behaviouralIndicators, the competencyArea it best evidences, a STAR score per
       dimension (situation/task/action/result, each a float in [0,1]), and an overall
       starCompleteness float in [0,1].
    2. Structured scorecard: for EACH competency in the supplied template, emit a
       competencyScore with an integer score 1-5, a VERBATIM evidenceQuote copied
       word-for-word from the transcript, and a short rationale. Then give an overall
       recommendation (STRONG_YES / YES / NO / STRONG_NO), a confidence level, and
       keyReasons[].
    3. Summary: a 3-paragraph executive summary as a single string with the paragraphs
       separated by a blank line ("\\n\\n"): (a) candidate background recap, (b)
       performance highlights, (c) concerns and recommended next steps.
    4. Calibration flags: scan the INTERVIEWER's turns and flag any LEADING_QUESTION
       (phrasing that steers the answer) and any ILLEGAL_QUESTION on an off-limits topic
       (pregnancy, family planning, religion, age, nationality, marital status,
       health/disability, race, sexual orientation). Each flag carries a severity, a
       detail, the verbatim interviewer evidenceQuote it is grounded in, and (for illegal
       questions) the illegalTopic. Do NOT emit SCORE_DIVERGENCE — panel divergence is
       computed elsewhere.
  </task_definition>
  <output_schema>
    Return EXACTLY one JSON object (no markdown fences, no commentary) of shape:
    {_OUTPUT_SCHEMA}
    Emit exactly one entry in scorecardDraft.competencyScores for EACH competency in the
    supplied template, in the order provided, reusing its competencyId and name.
  </output_schema>
  <constraints>
    - EVIDENCE IS MANDATORY (hallucination prevention): NEVER produce a competency score
      without a non-empty evidenceQuote copied VERBATIM from the transcript. If the
      transcript contains no evidence for a competency, score it 1, quote the closest
      relevant candidate sentence, and say so in the rationale and keyReasons — never
      invent a quote or a fact not in the transcript.
    - PRIVACY GUARD: this is a confidential transcript. Evaluate ONLY professional
      competencies demonstrated. DISREGARD any personal disclosures the candidate
      volunteers (health, disability, family, pregnancy, religion, age, nationality,
      marital status, race, sexual orientation) and DO NOT repeat or paraphrase such
      disclosures in ANY output field (summary, rationale, indicators, quotes). Never
      let a protected attribute influence a score.
    - When you flag an ILLEGAL_QUESTION, quote the INTERVIEWER's question only — never
      quote or restate the candidate's protected answer.
    - Be calibrated: 5 = exceptional concrete evidence; 3 = adequate; 1 = no/weak
      evidence. Do not inflate scores. If overall evidence is thin, set confidence "low".
    - You are advisory; never state a final hire decision as fact. Use inclusive,
      professional language throughout.
    - Always include the biasCheck object. If you notice yourself weighting anything
      other than demonstrated professional competence, correct course and record it in
      biasCheck.biasIndicatorsDetected with correctionApplied true.
  </constraints>
  {_FEW_SHOT}
</system>"""


def _competencies_block(competencies: list[dict[str, object]]) -> str:
    """Render the scorecard template competencies for the user turn."""
    lines: list[str] = []
    for c in competencies:
        cid = c.get("competencyId")
        name = c.get("name")
        desc = c.get("description")
        line = f"  - competencyId: {cid} | name: {name}"
        if desc:
            line += f" | description: {desc}"
        lines.append(line)
    return "\n".join(lines) if lines else "  (none supplied)"


def build_analyze_user_prompt(
    *,
    job_title: str | None,
    competencies: list[dict[str, object]],
    transcript_text: str,
) -> str:
    """Assemble the user turn from the job title, template competencies, and transcript."""
    title = job_title or "(unspecified)"
    return (
        f"<job_title>{title}</job_title>\n\n"
        "<scorecard_template>\n"
        f"{_competencies_block(competencies)}\n"
        "</scorecard_template>\n\n"
        "<confidential_interview_transcript>\n"
        f"{transcript_text}\n"
        "</confidential_interview_transcript>\n\n"
        "Analyse the transcript and return ONLY the JSON object matching the schema. "
        "Emit one competencyScore for every template competency, each with a VERBATIM "
        "evidence quote. Apply the privacy guard: do not repeat any personal disclosures."
    )
