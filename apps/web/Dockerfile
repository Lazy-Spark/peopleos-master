# syntax=docker/dockerfile:1
# PeopleOS web (Next.js 14) — container image for Railway or any Docker host.
#
# Build context = the REPO ROOT (the web consumes the @peopleos/schemas workspace
# package as source, so it needs the monorepo). On Railway: set this service's
# Root Directory to the repo root ("/") and the Dockerfile path to
# "apps/web/Dockerfile".
#
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so they
# are passed as build ARGs (Railway forwards service variables as build args).
FROM node:20-slim

# pnpm via corepack, pinned to the repo's packageManager.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# Build-time public config (baked into the static/client bundle by `next build`).
# A real Clerk deploy also passes NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; for the
# header-auth demo it is omitted and Clerk is skipped (see layout.tsx/middleware.ts).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DEV_ORG_ID
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_DEV_ORG_ID=$NEXT_PUBLIC_DEV_ORG_ID
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

# 1) Workspace manifests first (cached install layer). All members are copied so a
#    --frozen-lockfile install validates against the committed lockfile.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schemas/package.json packages/schemas/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/extension/package.json apps/extension/package.json
RUN pnpm install --frozen-lockfile

# 2) Sources needed to build the web app + its shared schemas package.
COPY tsconfig.base.json ./
COPY packages/schemas packages/schemas
COPY apps/web apps/web

# 3) Build the shared Zod contracts (their package.json "default" export points at
#    dist/, which a production `next build` resolves), then build Next.
RUN pnpm --filter @peopleos/schemas build
RUN pnpm --filter @peopleos/web build

ENV NODE_ENV=production
EXPOSE 3000
# Next binds to $PORT (Railway provides it; falls back to 3000 locally).
CMD ["sh", "-c", "cd apps/web && pnpm exec next start --hostname 0.0.0.0 --port ${PORT:-3000}"]
