"""Module 2c — candidate summary prompt (chat tool ``summarise_candidate``).

A short, advisory 1-2 sentence summary of a candidate, grounded ONLY in the provided
structured profile. Honours the prompt-engineering standards: XML-tagged system prompt,
>=2 few-shot examples, no protected-attribute inference, no data beyond the profile.
"""

from __future__ import annotations

PROMPT_VERSION = "module2.candidate_summary@1.0.0"

_FEW_SHOT = """<few_shot_examples>
  <example>
    <candidate_profile>{"experience":[{"company":"DataForge","title":"ML Engineer","description":"Built ranking + NLP models in PyTorch; owned MLOps deployment."}],"skills":[{"canonicalName":"Python"},{"canonicalName":"PyTorch"},{"canonicalName":"MLOps"}],"totalYoe":6}</candidate_profile>
    <output>Senior-leaning ML engineer (~6 yrs) with hands-on ranking/NLP modelling in PyTorch and production MLOps ownership — strong applied-ML signal from the profile.</output>
  </example>
  <example>
    <candidate_profile>{"experience":[{"company":"WebShop","title":"Backend Engineer","description":"Python/Django services; some data pipeline work."}],"skills":[{"canonicalName":"Python"}],"totalYoe":4}</candidate_profile>
    <output>Mid-level backend engineer (~4 yrs) in Python/Django with light data-pipeline exposure; limited evidence of ML depth from the profile alone.</output>
  </example>
</few_shot_examples>"""


def build_candidate_summary_system_prompt() -> str:
    """XML-tagged system prompt for the advisory candidate summary."""
    return f"""<system>
  <role>Recruiting analyst writing a concise 1-2 sentence ADVISORY candidate summary.</role>
  <constraints>
    - Use ONLY the provided structured profile. Never invent experience or skills.
    - Do NOT infer or mention protected attributes (age, gender, ethnicity, nationality).
    - Advisory only; output prose (no JSON, no markdown), 1-2 sentences.
  </constraints>
  {_FEW_SHOT}
</system>"""


def build_candidate_summary_user_prompt(profile_json: str) -> str:
    """Wrap the candidate profile JSON for the user turn."""
    return (
        "<candidate_profile>\n"
        f"{profile_json}\n"
        "</candidate_profile>\n\nWrite a 1-2 sentence advisory summary."
    )
