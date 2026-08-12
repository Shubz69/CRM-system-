# Worker process — durable jobs

Vercel serverless **cannot** host a persistent BullMQ worker. Long work (2–10
minutes) runs on a separate always-on process that shares this repo’s Prisma
client and services. Do not fork the codebase.

## What runs where

| Process | Host | Responsibility |
|---------|------|----------------|
| Next.js app | Vercel | HTTP, enqueue only (`src/jobs/*`) |
| Worker | Railway / Render / Fly / local | Consume `follow-ups` + `agent-runs` |
| Redis | Upstash (or Docker) | Shared via `REDIS_URL` |

### Queues

- **`follow-ups`** — short sweeps (due follow-ups). Concurrency 1.
- **`agent-runs`** — long jobs. Lock duration 15 minutes, concurrency from
  `AGENT_RUNS_CONCURRENCY` (default 2), exponential backoff.

Prompt 2A job names on `agent-runs`: `sleep-test`, `noop`. No agent logic yet.

## Local

```bash
# Terminal A — Redis
docker compose up -d redis

# Terminal B — Next.js
export REDIS_URL=redis://localhost:6379
npm run dev

# Terminal C — worker (same repo, same REDIS_URL + DATABASE_URL)
export REDIS_URL=redis://localhost:6379
export DATABASE_URL=...
npm run worker
```

If Redis is down locally, the worker logs loudly and starts an **in-process
follow-up loop only**. `agent-runs` does **not** fall back — long jobs will
not run.

## Deploy (Railway / Render / Fly)

1. Create a service from the **same** Git repo.
2. Start command: `npm run worker` (or `npx tsx src/workers/index.ts`).
3. Set env: `DATABASE_URL`, `DIRECT_URL` (if needed), `REDIS_URL` (same as
   Vercel), `ENCRYPTION_KEY`, AI keys as needed.
4. On Vercel: set the same `REDIS_URL` (Production + Preview).
5. Health: `GET /api/health` — in production, Redis `down` → **503 unhealthy**.

### Graceful shutdown

The worker handles `SIGTERM` / `SIGINT`: closes BullMQ workers (finishes or
requeues in-flight work), then exits. Hosts send SIGTERM on deploy — this is
expected.

## Five-minute verification (before Prompt 2B)

```bash
# As platform admin, enqueue a 5-minute sleep (HTTP only enqueues):
curl -X POST "$APP_URL/api/admin/jobs/sleep-test" \
  -H "Cookie: …" \
  -H "Content-Type: application/json" \
  -d '{"organisationId":"<org-id>","durationMs":300000,"note":"2A verify"}'

# Poll:
curl "$APP_URL/api/admin/jobs/sleep-test?jobId=<id>" -H "Cookie: …"
```

Confirm `state` becomes `completed` on the **worker host** logs, not inside
the HTTP request.

## What breaks if the worker is down

| Feature | Effect |
|---------|--------|
| Follow-up sends | Queue backs up; Vercel cron may still help if wired |
| `agent-runs` (sleep-test / future agents) | Jobs sit in Redis until a worker starts |
| Inbound DM AI replies | Unaffected (still synchronous in the request path for now) |
| Health check (production) | Unhealthy if Redis itself is down |

Redis down in production is a **hard failure** for health — not a warning.
