"""Module 8 — Internal Talent Marketplace / Internal Mobility AI surface.

The matching itself (recommended roles, "who can fill this role", succession bench,
mobility analytics) is SKILL-GRAPH driven and computed IN THE NODE API: it reuses the
Module 6 ``skillGap(employee, role)`` primitive to derive matchScore (= coverage),
readiness (READY_NOW / READY_SOON / STRETCH), and the matched / missing skill sets, and
attaches the Module 7 attrition TIER (governance: ADMIN/HRBP viewers only, never the raw
score) to internal candidates / successors. This stateless AI service provides the single
AI-reasoning surface on top of that match:

  recommend — the MOVE recommendation: a concise FIT SUMMARY for an internal move + a
              DEVELOPMENT PLAN (one step per MISSING skill), GROUNDED ONLY in the supplied
              matched / missing skills, with a bias guard (the recommendation is based ONLY
              on the skill match, never a protected attribute) and a biasCheck. Degrades to
              a clearly-marked deterministic offline fallback when ANTHROPIC_API_KEY is
              absent.

camelCase end-to-end (mirroring @peopleos/schemas mobility.ts).
"""

from .recommend import recommend_move

__all__ = ["recommend_move"]
