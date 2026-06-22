# PeopleOS

AI-native HR operating system — **ATS + HRMS + 10 AI agents** in one platform.
This repository is the **Phase 1 (MVP) foundation**: the monorepo, the multi-tenant
data layer, and the first vertical slice — **resume parsing → Module 1 (AI Resume
Screening & Candidate Ranking)**. The full product spec lives in
[`peopleos_master_prompt.md`](./peopleos_master_prompt.md) and is the authoritative
source for everything beyond this slice.

## Monorepo layout

```
peopleos-master/
├── packages/
│   └── schemas/          @peopleos/schemas — canonical Zod contracts (the single
│                         source of truth shared by API, web, and the AI service)
├── prisma/
│   ├── schema.prisma     all Phase 1 entities; org_id on every tenant table
│   ├── rls.sql           PostgreSQL Row-Level Security (multi-tenant isolation)
│   └── seed.ts           one demo org + users + job + candidates
├── apps/
│   ├── api/              Fastify REST API (TypeScript) — tenancy, RLS, OpenAPI
│   └── web/              Next.js 14 skeleton (App Router)
├── services/
│   └── ai/               Python FastAPI + LangGraph — resume parse + Module 1 ranker
├── infra/postgres/init/  DB bootstrap (pgvector + the RLS-subject app role)
└── docker-compose.yml    Postgres (pgvector), Redis, Neo4j, MinIO
```

## How the contract holds together

The data shapes are defined **once** in `@peopleos/schemas` (Zod, camelCase). The
Prisma models map those same camelCase field names to snake_case columns, and the
Python AI service mirrors them as Pydantic models emitting the same camelCase JSON.
Changing a shape means changing it in `packages/schemas` first.

## Multi-tenancy (read this before writing queries)

Isolation is enforced **at the database** by RLS, not just by application `WHERE`
clauses:

- The API connects as the non-owner role **`peopleos_app`** (`DATABASE_URL_APP`),
  which is *subject* to RLS. Prisma migrate/seed/studio use the owner role
  (`DATABASE_URL`), which *bypasses* RLS.
- Every request runs its queries inside a transaction that first sets
  `app.current_org_id` (via parameterised `set_config`). Policies compare each row's
  `org_id` to that setting and **fail closed** — forget to set it and you see zero
  rows, never another org's data.
- Always go through the API's `withTenant(orgId, …)` helper.

## Prerequisites

- Node 20 LTS + [pnpm](https://pnpm.io) 9
- Python 3.11+ (for `services/ai`)
- Docker (for local infra)

## Run it locally

```bash
# 1. Install JS deps
pnpm install

# 2. Start local infrastructure (Postgres+pgvector, Redis, Neo4j, MinIO)
pnpm infra:up

# 3. Configure env
cp .env.example .env   # fill in ANTHROPIC_API_KEY (and OPENAI_API_KEY for embeddings)

# 4. Create the schema, apply RLS, seed demo data
pnpm db:migrate         # prisma migrate dev
pnpm db:rls             # apply prisma/rls.sql  (psql "$DATABASE_URL" -f prisma/rls.sql)
pnpm db:seed

# 5. Start the AI service (Python)
cd services/ai && pip install -e . && uvicorn app.main:app --reload --port 8000

# 6. Start the API and web (from repo root, new terminals)
pnpm --filter @peopleos/api dev      # http://localhost:3001  (OpenAPI at /docs)
pnpm --filter @peopleos/web dev      # http://localhost:3000
```

> The `db:rls` script is `psql "$DATABASE_URL" -f prisma/rls.sql`. Add it to root
> `package.json` scripts if not present.

### Try the resume ranker

The seed creates org `00000000-0000-0000-0000-000000000001` with an open
"Senior ML Engineer" role and two candidates in `SCREENING`. In dev, the API
accepts an `X-Org-Id` header in place of a Clerk session:

```bash
# List the job's applications
curl -H "X-Org-Id: 00000000-0000-0000-0000-000000000001" \
  http://localhost:3001/api/v1/jobs/00000000-0000-0000-0000-0000000000b1/applications

# Rank a candidate against the job (Module 1)
curl -X POST -H "X-Org-Id: 00000000-0000-0000-0000-000000000001" \
  http://localhost:3001/api/v1/applications/<application-id>/rank
```

The response includes the tier (A–D), component scores, strengths/concerns, and a
summary — but **never** the chain-of-thought reasoning (that is stored server-side in
`candidate_rankings.reasoning` for audit only).

## Quality gates

- `pnpm typecheck` — strict TypeScript across all packages
- `pnpm test` — Zod contract tests (`packages/schemas`) + unit tests
- `cd services/ai && pytest` — AI service unit tests + Module 1 eval stub

## Responsible-AI guardrails (Phase 1)

Per the spec's prompt-engineering standards and ethics checklist, the resume ranker:
masks name / gender / graduation-year / school **before** the holistic LLM step;
attaches a `biasCheck` envelope to every output; keeps the AI **advisory only** (a
human advances/rejects); validates every model output with a schema before persisting;
and logs every scoring decision to the audit trail with model + prompt version.

## What's next (per spec phases)

This foundation covers Phase 1's core. Subsequent slices: JD writer / outreach
(Module 2), interview intelligence (Module 3), HR chatbot RAG (Module 4), the skill
graph (Module 6), attrition prediction (Module 7), and the agentic assistant
(Module 10). See `peopleos_master_prompt.md` → "Development Phases".
