# Redis / BullMQ cost controls (P0)

**Problem:** Upstash free tier hit ~500k commands/month at very low product usage — command amplification from always-on workers and duplicate execution paths, not from customer job volume.

**Never log `REDIS_URL` or tokens.**

---

## Root cause (traced in code)

Before this fix (`src/workers/index.ts` + jobs):

| Source | Effect |
|--------|--------|
| **3 BullMQ Workers** (follow-ups, agent-runs, maintenance) | Continuous BRPOP / stalled checks / lock renewal while idle |
| **setInterval(60s)** `processDueFollowUps` | Duplicated follow-up path alongside follow-ups Worker |
| **Hourly setInterval** retention + insights | Duplicated alongside `enqueueAgentRetentionSweep({ schedule: true })` repeatable job |
| **Follow-up Queue.add with `repeat: { every: 60_000 }`** | Would fire Redis every minute if ever enqueued |
| **Vercel cron `*/5`** `/api/cron` | Third follow-up + insights path |
| **`pingRedis()` new TCP connection** per call | Health / enqueue / AI Ops each paid connect+ping+quit |
| **AI Ops `getJobCounts` × 3 queues** | Extra Redis on every admin refresh |

Local `.env` pointing at Upstash made `npm run worker` / `npm run dev` burn the shared free-tier budget.

---

## Workers before → after

| | Before | After |
|--|--------|--------|
| BullMQ Workers | 3 (follow-ups, agent-runs, maintenance) | **1** (agent-runs only; on-demand maintenance rides same queue) |
| Follow-ups | Worker + 60s interval + optional cron | **Postgres interval on worker only** |
| Retention / insights | Worker repeatable + hourly intervals + cron | **Postgres hourly intervals on worker only** |
| Vercel cron | Always runs sweeps | **Only if `CRON_FALLBACK_ENABLED=true`** |
| Queue prefix | None | BullMQ `prefix` via `getBullMqPrefix()` ? `agentdesk-dev` / `agentdesk-test` / `agentdesk-preview` / `agentdesk-prod` (or `QUEUE_PREFIX`) |

---

## Local Redis behaviour

- Default `REDIS_URL=redis://localhost:6379` (`.env.example`, `env.ts`).
- `docker compose up -d redis` supplies local Redis.
- If `NODE_ENV` / runtime is development or test and URL contains `upstash.io`, **worker startup fails** unless `ALLOW_REMOTE_REDIS_IN_DEV=true`.
- `npm run dev`, `npm run worker`, `npm test`, e2e must not contact Upstash when using the default local URL.

---

## Production Redis behaviour

- `REDIS_URL` set only in deployment (Vercel/worker host) to dedicated Upstash (or equivalent).
- Queue keys: BullMQ native prefix `agentdesk-prod` + logical name `agent-runs` (never `prod:agent-runs` as the queue name).
- Idle: one Worker stalled checker (~`AGENT_RUN_STALLED_INTERVAL_MS`, default 120s) + blocking pop when idle.
- Follow-ups / retention: **zero Redis** (Postgres timers).
- Durable missions, approvals, CRM, research, publish outcomes: **Postgres**. Redis flush must not delete them.

---

## Idle Redis traffic remaining (expected)

After fix, idle hosted worker still generates some Redis commands from the **single** agent-runs Worker (BullMQ blocking pop + periodic stalled check). That is far lower than three workers + repeatables + cron + ping storms.

| Scenario | Redis |
|----------|--------|
| Idle worker | ~1 Worker BRPOP/stalled; no follow-up/maintenance Redis |
| One AgentRun | enqueue + process + complete (bounded) |
| One follow-up sweep | **Postgres only** |
| One maintenance sweep | **Postgres only** |
| AI Ops refresh | Cached ping (5s) + agent-runs `getJobCounts` cached 30s |

**Estimated idle reduction:** roughly **~3× fewer Workers** plus removal of 60s/hourly Redis repeatables and duplicate cron — order-of-magnitude drop in idle command rate when volume is near zero. Exact Upstash billing counts are not asserted in tests.

---

## Guards & observability

- `assertRedisUrlAllowedForRuntime()` — remote Upstash blocked in dev/test without opt-in.
- Job `attempts` capped at 3 on enqueue.
- In-process duplicate worker start refused (`queue-ops` claim).
- AI Ops shows `queueOps` (process counters) + topology; not fake Upstash billing.

---

## Outbox idle DB activity (Phase 12B)

Hosted worker also runs a Postgres outbox sweep every `OUTBOX_SWEEP_INTERVAL_MS` (default **15s**) plus stale-claim recovery and a mission-queue recovery sweep every `MISSION_QUEUE_RECOVERY_INTERVAL_MS` (default **60s**).

These hit **Postgres only** — not Redis. No permanent BullMQ worker for the outbox.

Expected idle: one `SELECT … FOR UPDATE SKIP LOCKED` batch (often empty) per interval.

### Retention (policy — not automated purge yet)

- Hot window: operational PENDING/RETRY/PROCESSING stay until resolved.
- Processed / CANCELLED / DEAD_LETTER rows: keep for ops/audit; do **not** auto-delete in production without a tested retention job.
- Future: organisation/platform policy for archive/purge of low-value PROCESSED events older than N days; DEAD_LETTER and security-related rows retain longer.
