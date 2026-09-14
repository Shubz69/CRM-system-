# Worker process — durable jobs

Vercel serverless **cannot** host a persistent BullMQ worker. Long work (2–10
minutes) runs on a separate always-on process that shares this repo’s Prisma
client and services. Do not fork the codebase.

## What runs where

| Process | Host | Responsibility |
|---------|------|----------------|
| Next.js app | Vercel | HTTP. **QUICK Ask (CRM + web research) runs in the web process** — it does not wait on BullMQ. |
| Worker | Railway / Render / Fly / local | Consume `agent-runs` for **DEEP** Ask and other durable jobs. Start: `npm run worker` / `npm run worker:prod`. |
| Redis | Upstash (or Docker) | Shared via `REDIS_URL` **and the same `QUEUE_PREFIX`** as Vercel |

**If the hosted worker is not running:** QUICK Ask still returns sourced findings in-process. DEEP Ask used to sit in Redis until wall-clock fired with **0 steps / empty output**. The web app now detects a stale worker heartbeat and runs DEEP locally via `after()` instead of burning the budget in an empty queue.

Admin → AI Ops shows **Hosted worker live** vs **Hosted worker down** from a Redis heartbeat (not “Redis ping = worker is up”).

### Queues

- **`follow-ups`** — short sweeps (due follow-ups). Concurrency 1.
- **`agent-runs`** — long jobs. Lock duration 15 minutes, concurrency from
  `AGENT_RUNS_CONCURRENCY` (default 2), exponential backoff.

Prompt 2A job names on `agent-runs`: `sleep-test`, `noop`.
Prompt 2B adds `agent-framework-run` (loads `AgentRun` by id + org, plans and
executes registered agents; writes `AgentStep` rows as work progresses).

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

**Default production topology:** Vercel (Next.js) + **hosted worker** on Railway or Render from this same repo.

Copy-paste configs in-repo:

- `railway.toml` — start `npm run worker`
- `render.yaml` — worker service blueprint

1. Create a worker service from the **same** Git repo.
2. Start command: `npm run worker` (or `npx tsx src/workers/index.ts`).
3. Set env: `DATABASE_URL`, `DIRECT_URL` (if needed), `REDIS_URL` (same as
   Vercel), `ENCRYPTION_KEY`, AI keys as needed. **`TAVILY_API_KEY` / `EXA_API_KEY`
   on Railway do not serve Quick Ask** — copy those keys to Vercel Production
   as well (Quick web research runs in the Next.js process).
4. On Vercel: set the same `REDIS_URL` (Production + Preview).
5. Health: `GET /api/health` — in production, Redis `down` → **503 unhealthy**.
6. Ops UI: `/admin/ai-ops` shows queue depths + failed jobs (real BullMQ counts).
7. Go Live checklist treats Redis + worker as **required** for Ask (cron does not run `agent-runs`).

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

**QUICK Ask web research runs in the Vercel web process.** If Tavily/Exa keys
exist only on Railway, Quick Ask returns `AUTH_REQUIRED` (set `TAVILY_API_KEY`
or `EXA_API_KEY` on Vercel Production + Preview). DEEP Ask on the worker can
use the Railway copies of the same keys.

## What breaks if the worker is down

| Feature | Effect |
|---------|--------|
| QUICK Ask (CRM + “Research …”) | Still runs in the Vercel/web process |
| DEEP Ask / queued `agent-runs` | Web falls back to in-process `after()` when the worker heartbeat is stale; otherwise jobs would sit in Redis until wall-clock with 0 steps |
| Follow-up sends | Postgres sweep on the worker host; cron only if `CRON_FALLBACK_ENABLED` |
| Health / AI Ops | Redis OK ≠ worker up. Heartbeat must be fresh. |

Redis down in production is a **hard failure** for `/api/health` — not a warning. Worker-down is **degraded DEEP Ask**, not a 503 on the web app.

