#!/bin/sh
# Boot the PeopleOS API: sync the schema, seed the demo org (idempotent), then serve.
# Designed for Railway (binds to $PORT). DATABASE_URL must be the Postgres OWNER URL
# (used by `prisma db push` + the seed); the API itself reads DATABASE_URL_APP at runtime
# (for a single-org demo both can point at the same Railway Postgres connection string).
set -e

echo "[peopleos-api] prisma db push (sync schema to the database)…"
pnpm exec prisma db push --skip-generate

echo "[peopleos-api] seeding the demo org (idempotent upserts)…"
pnpm exec tsx prisma/seed.ts || echo "[peopleos-api] seed step failed/skipped — continuing to serve"

export API_PORT="${PORT:-3001}"
export API_HOST="0.0.0.0"
echo "[peopleos-api] starting API on ${API_HOST}:${API_PORT}…"
cd apps/api
exec pnpm exec tsx src/server.ts
