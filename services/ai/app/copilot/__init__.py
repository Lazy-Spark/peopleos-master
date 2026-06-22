"""Module 2 — Recruiter Copilot (spec Layer 4).

Four AI surfaces, all camelCase end-to-end (mirroring @peopleos/schemas copilot.ts):
  2a jd_writer      — generate an inclusive, tone-matched job description
  2b outreach       — personalised candidate outreach (warm/formal/brief + InMail)
  2c chat_agent     — bounded reason->act->observe ReAct agent with internal tools
  2d linkedin       — analyse a scraped LinkedIn profile + match against open roles

Every LLM-backed surface applies the 7 prompt-engineering standards and degrades to
a clearly-marked deterministic offline fallback when ANTHROPIC_API_KEY is absent.
"""

from __future__ import annotations
