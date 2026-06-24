# Deploying PeopleOS to Railway

This gets the app **functional**: the web UI loads real data (jobs, candidates, …) instead
of *"Failed to load jobs. Is the API running on NEXT_PUBLIC_API_URL?"*.

## Why that error happens (the 3 root causes — all fixed in this repo now)

PeopleOS is **three deployables**: the **web** (Next.js), the **API** (Fastify), and a
**database**. The web is only a front end — every byte of data comes from the API. The
screenshot error means the web couldn't reach a working API. Three things blocked that;
the code changes in this repo fix all three:

1. **The API was never deployed** → there was nothing for the web to call. (This guide
   deploys it.)
2. **A production web build sent no auth header.** The web only attached the dev tenant
   header (`X-Org-Id`) when `NODE_ENV !== production`. Fixed: it now sends it whenever
   `NEXT_PUBLIC_DEV_ORG_ID` is set (opt-in), so a header-auth demo works in prod.
3. **The API had no CORS.** A browser on the web's domain can't call the API's domain
   without it. Fixed: the API now sends CORS headers (configurable via `CORS_ORIGINS`).

> **First, push the repo** so Railway builds the fixed code:
> ```bash
> ! gh auth login        # if not already authenticated
> ! git push -u origin main
> ```

## What you'll create on Railway

A single project with **4 services**: **Postgres**, **Redis**, the **API**, and your
existing **web**. (The **AI service** is an optional 5th — Phase 2, for the Assistant /
ranking; the core ATS works without it.)

```
[ web (Next.js) ]  --HTTPS-->  [ API (Fastify) ]  -->  [ Postgres ]
   already live                 this guide              [ Redis ]
        |                            |
        └── NEXT_PUBLIC_API_URL ─────┘
```

**Seed org id (you'll need it below):** `00000000-0000-0000-0000-000000000001`

---

## Step 1 — Add Postgres + Redis

In your Railway project: **New → Database → Add PostgreSQL**, then again **Add Redis**.
That's it — no pgvector or extra setup needed (the schema doesn't use it; the API creates
its tables on first boot via `prisma db push`).

## Step 2 — Deploy the API

1. **New → GitHub Repo →** select `Lazy-Spark/peopleos-master`.
2. In the new service's **Settings**:
   - **Root Directory:** `/` (the repo root)
   - **Build:** it will detect `apps/api/Dockerfile`. If it doesn't, set **Dockerfile
     Path** = `apps/api/Dockerfile` (Settings → Build → Custom Dockerfile).
3. **Variables** (Settings → Variables) — paste these (Railway resolves the `${{…}}`
   references to the plugins from Step 1):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `development` |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `DATABASE_URL_APP` | `${{Postgres.DATABASE_URL}}` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `CORS_ORIGINS` | `https://<your-web-domain>` (fill in after you know it; or `*` to start) |

   > `NODE_ENV=development` is deliberate — it enables the API's header-based tenant
   > fallback so you don't need to wire up Clerk to see it work. See **Security** below.

4. **Settings → Networking → Generate Domain.** Note the URL, e.g.
   `https://peopleos-api-production.up.railway.app`.
5. Watch the **deploy logs**. On boot you should see `prisma db push`, `seeding the demo
   org`, then `starting API on 0.0.0.0:<port>`. Sanity-check it:
   - `https://<api-domain>/health` → `{ "status": "ok", … }`
   - `https://<api-domain>/docs` → the OpenAPI/Swagger UI.

## Step 3 — Point the web at the API

On your **existing web service → Variables**, set:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api-domain>` (from Step 2.4) |
| `NEXT_PUBLIC_DEV_ORG_ID` | `00000000-0000-0000-0000-000000000001` |

Keep your existing `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Then **Redeploy** the web (so it
picks up the new code + variables — `NEXT_PUBLIC_*` are baked in at build time).

Go back to the API service and set `CORS_ORIGINS` to the web's exact origin
(`https://<your-web-domain>`, no trailing slash) if you used `*` earlier, and redeploy the
API.

## Step 4 — Verify

Open the web app → **Jobs**. You should now see **1 open role** ("Senior Machine Learning
Engineer") and the candidates under it — the seeded demo data. The red banner is gone. 🎉

If it's still erroring, see **Troubleshooting**.

## Step 5 (optional) — AI features (Assistant, ranking)

The Assistant, resume ranking, etc. need the **AI service** + your model keys.

1. **New → GitHub Repo →** same repo. **Settings → Root Directory:** `services/ai`
   (it has its own `Dockerfile`). Generate a domain.
2. **AI service Variables:**

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your Anthropic key |
   | `OPENAI_API_KEY` | your OpenAI key (embeddings) |
   | `AI_SERVICE_SECRET` | a long random string |
   | `PEOPLEOS_API_URL` | `https://<api-domain>` |
   | `ANTHROPIC_MODEL` | `claude-sonnet-4-6` (optional) |

3. On the **API service**, add the matching pair so it can call the AI service:

   | Variable | Value |
   |---|---|
   | `AI_SERVICE_URL` | `https://<ai-service-domain>` |
   | `AI_SERVICE_SECRET` | **the same** random string as above |

   Redeploy the API. The Assistant (`/assistant`) and AI ranking now work.

---

## Security — read this before sharing the URL

This deployment runs the API with `NODE_ENV=development` so it trusts the client-supplied
`X-Org-Id` header (no Clerk login). For a **single-org demo that's fine**, but **anyone who
knows the URL can read/write that org's data** — do not put real personal data in it.

**To harden into a real multi-tenant deployment:** set `NODE_ENV=production` on the API and
configure Clerk end-to-end — set `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY` on the API, a
Clerk JWT template emitting `org_id` + `role` claims, real sign-in on the web, and **unset**
`NEXT_PUBLIC_DEV_ORG_ID`. The org is then derived from the verified session, and for true
tenant isolation create a non-superuser `peopleos_app` Postgres role (see
`infra/postgres/init/01-init.sql`), point `DATABASE_URL_APP` at it, and apply
`prisma/rls.sql`.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| "Failed to load jobs…" still | The web can't reach the API. Confirm `NEXT_PUBLIC_API_URL` is the API's **https** domain and that `https://<api-domain>/health` returns ok. Remember `NEXT_PUBLIC_*` requires a **web redeploy**. |
| Browser console: **CORS** error | `CORS_ORIGINS` on the API doesn't match the web origin exactly. Set it to `https://<your-web-domain>` (no trailing slash) and redeploy the API. (`*` also works for a quick test.) |
| API logs: 401 on every call | The web isn't sending `X-Org-Id`. Ensure `NEXT_PUBLIC_DEV_ORG_ID` is set on the **web** and you redeployed it, and the API has `NODE_ENV=development`. |
| API won't boot: invalid env | Check `DATABASE_URL_APP` and `REDIS_URL` are set (the `${{…}}` references resolve only if the Postgres/Redis plugins exist in the same project). |
| API logs: db push / connect error | The Postgres plugin isn't linked. Confirm `DATABASE_URL` references `${{Postgres.DATABASE_URL}}`. |
| Assistant says it's offline | The AI service isn't deployed or `ANTHROPIC_API_KEY` is unset (Step 5). |
