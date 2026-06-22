"""Module 5e — Workforce Analytics Dashboard AI surfaces (spec Layer 4).

Two AI surfaces over a frozen ``DashboardMetrics`` snapshot (computed IN THE API from
Postgres; prod: Snowflake + DBT). Both are grounded ONLY in the supplied metrics — the
AI never queries data and never generates SQL — and degrade to a clearly-marked
deterministic offline fallback when ANTHROPIC_API_KEY is absent:

  narrative — AI executive narrative + rule-checkable anomalies (5e narrative insights)
  ask       — "Ask your data" NL Q&A over the snapshot with an optional chart (5e)

camelCase end-to-end (mirroring @peopleos/schemas analytics.ts).
"""

from .ask import answer_data_question
from .narrative import generate_narrative

__all__ = ["answer_data_question", "generate_narrative"]
