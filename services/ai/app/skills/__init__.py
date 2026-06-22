"""Module 6 — Employee Skill Graph AI surfaces (spec Layer 3A + Layer 4).

The skill graph is modelled relationally in Postgres (Neo4j is the documented prod
adapter) and graph queries are computed in the API via Prisma joins; this stateless
service provides the two AI-reasoning surfaces on top of it. Both ground their reasoning
ONLY in the supplied skills / counts and degrade to a clearly-marked deterministic offline
fallback when ANTHROPIC_API_KEY is absent:

  growth_path  — 6a: "you are N skills away from <role>" + recommended missing skills with
                 a why + a suggested training, grounded in the employee's own skills, with
                 a bias guard (growth is based ONLY on the skill gap, never a protected
                 attribute) and a biasCheck.
  build_vs_buy — 6c: BUILD / BUY / HYBRID for a skill gap, from a deterministic supply vs
                 demand vs trainable-pool rule, with a concise rationale.

camelCase end-to-end (mirroring @peopleos/schemas skills.ts).
"""

from .build_vs_buy import recommend_build_vs_buy
from .growth_path import generate_growth_path

__all__ = ["generate_growth_path", "recommend_build_vs_buy"]
