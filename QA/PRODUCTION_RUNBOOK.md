# Agent Desk — Production Runbook

Current architecture (do not invent alternatives here):

| Layer | Reality |
|-------|---------|
| Web | Next.js on **Vercel** (`crm-system-eight-wine.vercel.app`) |
| DB | **Supabase** Postgres project `zezhgfkefglrhkuccosh` (pooler for app; direct for migrations) |
| Worker | **Railway** — `npm run worker` / `worker:prod`, **1×** BullMQ queue `agent-runs` |
| Redis | Upstash/Redis via `REDIS_URL` — required in production health |
| Auth | NextAuth / Auth.js — `AUTH_SECRET` / `NEXTAUTH_SECRET` |
| Optional providers | ManyChat, Meta Instagram, booking, Apify, SMTP, social publish |

Related: `docs/DEPLOYMENT.md`, `docs/WORKER.md`, `docs/CREDENTIAL-ROTATION.md`, `docs/MIGRATIONS.md`, `QA/RELEASE_CHECKLIST.md`.

---

## WEB APP DOWN

1. Open `https://crm-system-eight-wine.vercel.app/api/health` — expect `ok: true`, `database.ok`, `redis.ok`.
2. Vercel → Project → Deployments — confirm latest Production SHA matches `origin/main`.
3. If deploy failed: Redeploy last known-good SHA (Vercel rollback / promote previous deployment).
4. If health `database` down: check Supabase project status / connection string / pooler.
5. If health `redis` down: check Upstash; web may degrade Ask queues — worker also affected.
6. Check Vercel Functions logs for 5xx storms (auth, DB pool, env missing).

## WORKER DOWN

1. Railway service status + logs for `agent-runs` / interval sweeps. Start command must be `npm run worker:prod` (see `railway.toml`).
2. Admin → AI Ops: **Hosted worker down** with Redis OK means the web app can ping Redis but **no worker has written a heartbeat** on this `QUEUE_PREFIX`. Confirm Railway and Vercel share `REDIS_URL` (preview uses `agentdesk-preview`; production worker must not be the only listener if you test preview).
3. **QUICK Ask still runs** in the Vercel function. **DEEP Ask** should fall back to in-process execute when the heartbeat is stale — it must not sit until MAX_WALL_CLOCK with 0 steps.
4. Confirm **replicas = 1** (never scale BullMQ agent-runs horizontally without redesign).
5. Confirm `NODE_ENV=production` and same secrets as Vercel for DB/Redis/encryption.
6. If Redis quota circuit OPEN: worker **pauses** agent-runs (does not crash-loop). Wait for quota recovery; do not spam restarts.
7. Restart Railway service once after config fix.

## DATABASE AUTH FAILURE

1. Supabase → Database settings — password / network restrictions.
2. Prefer **transaction pooler :6543** for app; **direct** URL for `prisma migrate deploy`.
3. Rotate DB password in Supabase → update `DATABASE_URL` / `DIRECT_URL` on Vercel **and** Railway → redeploy both.
4. Do **not** run `prisma db push` in production.
5. After restore: `npx prisma migrate status` must show up to date.

## REDIS FAILURE

1. Health redis `down` / `degraded` → Upstash dashboard (quota, auth).
2. Rotate `REDIS_URL` on Vercel + Railway; redeploy/restart.
3. Worker Redis circuit: fatal provider quota → pause BullMQ; Postgres-backed sweeps (outbox, follow-ups) may continue.
4. Do not add a second BullMQ worker to “fix” Redis.

## BAD DEPLOY

1. Note broken SHA from Vercel / git.
2. Promote previous healthy Vercel deployment (same git SHA that was soak-tested).
3. Align Railway to same commit if worker image tracks git.
4. Re-check `/api/health` + sample login + one Ask + webhook smoke.
5. Do not “fix forward” with `db push`.

## BAD MIGRATION

1. **Stop** further deploys.
2. Identify migration name from `prisma/migrations`.
3. Prefer restore from Supabase backup / PITR to pre-migration point if data corrupted.
4. Additive-safe migrations (enum + new tables) can often stay; destructive mistakes need restore.
5. Re-apply only with `npx prisma migrate deploy` after restore.
6. Never hand-edit `_prisma_migrations` unless an expert recovery plan is written down.

## PROVIDER OUTAGE

| Provider | Symptom | Action |
|----------|---------|--------|
| Anthropic | Ask / agent fails | Check key + Anthropic status; health providers show CONFIGURED only |
| ManyChat | Inbound silent / 401 | Validate org webhook secret + channel mapping; not Meta |
| Meta Instagram | 503 META_NOT_CONFIGURED / signature 401 | Optional — fix app secrets / verify token; must not break ManyChat |
| Booking | 401 invalid secret | Rotate booking secret both sides |
| Apify / Tavily / YouTube | Research empty / budget | **QUICK Ask reads Tavily/Exa from Vercel**, not Railway. If ResearchJob `error=no_sources` after in-process Quick (e.g. `cmu149j980005la04wfakopf8`), copy `TAVILY_API_KEY` + `EXA_API_KEY` from Railway → Vercel Production + Preview. Do not invent keys. Worker-path jobs on 2026-09-13 had sources=6 for the same plant-hire topic. |
| SMTP | Invites show copy-link | Set `EMAIL_SMTP_URL` + `EMAIL_FROM`; failed send must stay `emailSent: false` |

## WEBHOOK FAILURE

1. Identify provider from path: `/api/webhooks/manychat`, `/booking`, `/meta/instagram`.
2. Check rate limit 429 vs 401 secret/signature vs 503 Meta not configured.
3. Confirm optional Meta absence does **not** cause ManyChat/booking 500s (regression covered in unit tests).
4. Admin → webhooks / failed jobs for retry (platform admin).
5. Fix secret in provider console + Vercel; do not weaken `assertProductionSecretsConfigured`.

## SECRET EXPOSURE

1. Treat all previously shared `.env` as burned — follow `docs/CREDENTIAL-ROTATION.md`.
2. Rotate auth, webhook secrets, AI keys, DB, Redis, OAuth app secrets in provider consoles first, then Vercel/Railway.
3. **Do not** casually rotate `ENCRYPTION_KEY` (ciphertext becomes unreadable).
4. Revoke Meta / ManyChat / social tokens; tenants reconnect.
5. Invalidate sessions by rotating `AUTH_SECRET` / `NEXTAUTH_SECRET` (users re-login).
6. Audit git history; if secrets were committed, rotate and scrub with ops process.

## BACKUP / RECOVERY ASSUMPTIONS

- Supabase: enable **PITR / daily backups** on the paid plan you actually use; verify in dashboard (not assumed free-tier).
- App rollback: Vercel deployment promote.
- Worker: Railway restart / redeploy prior image.
- Redis: ephemeral queues — durable work lives in Postgres (outbox, missions, AgentRun).
- Migrations: only `prisma migrate deploy`; recovery = backup restore + redeploy known SHA.
