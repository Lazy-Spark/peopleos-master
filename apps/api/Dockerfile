# syntax=docker/dockerfile:1
# PeopleOS API (Fastify) — container image for Railway or any Docker host.
#
# Build context = the REPO ROOT. On Railway: set the API service's Root Directory to the
# repo root ("/") and the Dockerfile path to "apps/api/Dockerfile".
#
# The API runs via tsx (transpile-only), so deploying does NOT require a clean `tsc`
# across the repo's pre-existing type debt. On boot it pushes the Prisma schema and seeds
# the demo org (both idempotent), then listens on $PORT (Railway provides it).
FROM node:20-slim

# OpenSSL + CA certs: Prisma's schema/query engine needs libssl at runtime;
# node:20-slim ships without it, so `prisma db push` fails on boot with a
# "Schema engine error" unless we install it here.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned to the repo's packageManager.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# 1) Workspace manifests first (cached install layer). All members are copied so a
#    --frozen-lockfile install validates against the committed lockfile.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/extension/package.json apps/extension/package.json
RUN pnpm install --frozen-lockfile

# 2) Sources needed to build + run the API.
COPY tsconfig.base.json ./
COPY prisma prisma
COPY packages/schemas packages/schemas
COPY apps/api apps/api

# 3) Build the shared Zod contracts + generate the Prisma client.
RUN pnpm --filter @peopleos/schemas build && pnpm exec prisma generate

ENV NODE_ENV=development
ENV API_HOST=0.0.0.0
EXPOSE 3001
CMD ["sh", "apps/api/docker-entrypoint.sh"]
