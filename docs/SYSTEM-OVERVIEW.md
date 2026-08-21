# Agent Desk — Full System Overview

This document describes the **entire** Agent Desk CRM: product purpose, features, architecture, infrastructure, data model, AI/research pipeline, security, and how the pieces deploy together.

Related deep-dives live under `docs/` (linked at the end). This file is the single map of the whole system.

---

## 1. What it is

**Agent Desk** (`agent-desk`) is a multi-tenant AI workspace for agencies and operators who:

- Research markets and **social trends** (recent / viral content, hooks, algorithm takes)
- Qualify inbound conversations (ManyChat / Instagram DMs)
- Run a CRM pipeline (contacts, leads, stages, bookings)
- Maintain Knowledge for grounded AI replies
- Manage automations, spend, and platform tenants as admins

Live production (this project): typically **Vercel** (app) + **Supabase** (Postgres) + **Upstash** (Redis) + a separate **worker** process.

---

## 2. Who uses it

| Audience | What they do |
|----------|----------------|
| **Workspace users** (OWNER / ADMINISTRATOR / MANAGER / SALES_AGENT / ANALYST / READ_ONLY) | Ask, Inbox, Pipeline, Knowledge, reports, setup |
| **Platform admins** (`isPlatformAdmin` / `SUPER_ADMIN`) | Workspaces, users, AI usage, health, webhooks, failed jobs, audit |

All business data is scoped by **`organisationId`**. Cross-org access is rejected by construction.

---

## 3. Product surface (routes)

From `src/lib/navigation.ts`:

| Area | Routes | Purpose |
|------|--------|---------|
| **Home / Ask** | `/ask` | Natural-language outcomes: research, listening, content, imaging |
| **CRM** | `/inbox`, `/pipeline`, `/contacts` | Conversations, stages, people |
| **Work** | `/knowledge`, `/insights`, `/reports`, `/agent` | Docs, metrics, AI Operator config |
| **Setup** | `/integrations`, `/settings`, `/settings/go-live`, `/setup` | Keys, checklist, Setup Assistant |
| **Ops** | `/attention`, `/automations`, `/autopilot`, `/qualification`, `/simulator`, `/dashboard` | Exceptions, rules, scoring, DM simulator |
| **Admin** | `/admin`, `/admin/workspaces`, `/admin/users`, `/admin/usage`, `/admin/health`, `/admin/webhooks`, `/admin/failed-jobs`, `/admin/audit`, `/admin/settings` | Platform console |
| **Auth** | `/login`, `/forgot-password`, `/reset-password`, `/account/change-password` | Credentials auth |

---

## 4. High-level architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                         Clients (browser)                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTPS
┌───────────────────────────────▼─────────────────────────────────┐
│              Next.js 16 App (Vercel serverless)                  │
│  UI · API routes · NextAuth · webhooks · enqueue only            │
│  Inbound DM AI still runs synchronously in the request path      │
└───────┬─────────────────┬──────────────────┬────────────────────┘
        │                 │                  │
        ▼                 ▼                  ▼
┌───────────────┐  ┌──────────────┐  ┌────────────────────────────┐
│ Supabase      │  │ Upstash      │  │ External APIs              │
│ Postgres      │  │ Redis        │  │ Anthropic, OpenAI, Apify,  │
│ (Prisma)      │  │ (BullMQ)     │  │ YouTube, Tavily, ManyChat… │
└───────▲───────┘  └──────▲───────┘  └────────────────────────────┘
        │                 │
        │          ┌──────┴───────────────────────────┐
        └──────────┤  Worker (always-on host)         │
                   │  npm run worker                  │
                   │  Queues: follow-ups, agent-runs, │
                   │  maintenance                     │
                   └──────────────────────────────────┘
```

| Process | Host | Responsibility |
|---------|------|----------------|
| **Web app** | Vercel | HTTP, auth, UI, webhooks, **enqueue** Ask/jobs |
| **Worker** | Railway / Render / Fly / local PC | **Consume** long jobs (Ask research, retention, follow-ups) |
| **Redis** | Upstash (prod) or Docker | Job queues + locks |
| **Postgres** | Supabase (prod) or Docker / embedded | System of record |

**Critical:** Without a running worker sharing the same `DATABASE_URL` + `REDIS_URL`, Ask jobs sit in Redis and never finish.

Vercel cron (`vercel.json`, every 5 minutes → `/api/cron`) is a **follow-up fallback**, not a replacement for the Ask worker.

---

## 5. Tech stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js **16.3** App Router, React **19**, TypeScript |
| UI | Tailwind CSS 4, Radix UI, Sonner toasts |
| Database | PostgreSQL + Prisma 6 (`vector` extension for embeddings) |
| Auth | NextAuth v4 (JWT + credentials / bcrypt) |
| Jobs | BullMQ + ioredis |
| Validation | Zod |
| Tests | Vitest (unit), Playwright (e2e) |
| Email | Nodemailer when `EMAIL_SMTP_URL` is set |

---

## 6. Code layout

| Path | Role |
|------|------|
| `src/app` | Pages + API route handlers |
| `src/services` | Business workflows (Ask enqueue, inbound pipeline, spend gate, …) |
| `src/agents` | Ask agent framework (research, analyst, critic, imaging, supervisor) |
| `src/adapters` | Ports: AI, sources, messaging, booking, social OAuth, email, images |
| `src/workers` | BullMQ consumers |
| `src/jobs` | Queue helpers |
| `src/lib` | Auth, env, permissions, DB client, navigation |
| `prisma` | Schema + migrations + seed |
| `docs` | Topic guides |

---

## 7. Ask / agent pipeline (social research)

User submits plain English on `/ask` → API creates an **`AgentRun`** and enqueues **`agent-framework-run`** on Redis → **worker** executes planned steps.

Typical **research** plan:

1. **research** — expand queries (viral / this week / shorts / reels), search configured sources (YouTube, web/Tavily, Apify social, …), store sources + findings  
2. **analyst** — produce a **social pack**:
   - Short answer (bullets)
   - Executive summary + **full brief**
   - **Viral examples** with real video/post URLs
   - **Next on the algorithm** predictions
   - Content hooks + algorithm notes
   - Cited claims (URLs must match collected sources)
3. **critic** — verify citations; must **not** wipe the analyst brief (merged into final output)

**Social listening** plan swaps step 1 for `social_listening` (high-engagement posts → same analyst/critic).

Imaging flows: analyze reference → user confirms prompt → generate (spend-gated).

Progress is polled via `GET /api/ask/[runId]`. AI **spend / allowance** strings are returned only for admin roles (`OWNER` / `ADMINISTRATOR` / `SUPER_ADMIN` / platform admin).

---

## 8. Inbound messaging pipeline

```text
ManyChat webhook / Simulator
        → secret + Zod
        → WebhookEvent (idempotency)
        → Contact + Conversation + Message + Lead
        → Knowledge retrieval
        → AI structured reply (Zod + one repair)
        → Scoring / objections / follow-ups
        → Outbound via messaging adapter
        → Inbox / Insights
```

Details: `docs/ARCHITECTURE.md`, `docs/MANYCHAT.md`, `docs/AI_AGENT.md`.

---

## 9. Adapters (integrations)

| Area | Implementations |
|------|-----------------|
| **AI chat** | Anthropic (primary), OpenAI, Groq, Mistral, DeepSeek, Gemini, mock |
| **Embeddings** | OpenAI / mock / none |
| **Images** | OpenAI / Gemini |
| **Research sources** | YouTube, Reddit, Tavily/Exa web; Apify: Instagram, LinkedIn, TikTok, Twitter-X, Threads |
| **Messaging** | ManyChat live + mock |
| **Booking** | Link / mock |
| **Social OAuth (tenant)** | Instagram, LinkedIn, TikTok connect/publish (`docs/SOCIAL_CONNECTIONS.md`) — separate from Apify public search |
| **Email** | SMTP (nodemailer) when configured |
| **Sheets** | Google Sheets / mock |

Provider health: `GET /api/health/providers` and **Admin → System Health**.

---

## 10. Auth, roles, permissions

- **Login:** email + password (NextAuth credentials). JWT session.
- **Lockout:** 5 failed attempts → 15 minutes.
- **Password reset:** token in DB; email when SMTP configured; ops recovery via `ADMIN_BOOTSTRAP_SECRET` header / Setup UI.
- **Membership:** `OrganisationMember.role` drives permissions (`src/lib/permissions.ts`).

| Role | Rough access |
|------|----------------|
| `SUPER_ADMIN` | All workspace + platform permissions |
| `OWNER` | All workspace permissions |
| `ADMINISTRATOR` | Manage members, agent, integrations, knowledge, audit, … |
| `MANAGER` | Day-to-day ops without full admin |
| `SALES_AGENT` | Ask, inbox write, leads |
| `ANALYST` / `READ_ONLY` | Mostly read |

Platform console requires platform admin / `platform:manage`.

---

## 11. Data model (highlights)

Prisma schema: `prisma/schema.prisma`.

**Tenancy & identity:** `Organisation`, `User`, `OrganisationMember`, NextAuth tables.

**CRM:** `Contact`, `Conversation`, `Message`, `Pipeline` / `PipelineStage`, `Lead`, qualification, scores, `Booking`, `FollowUp`.

**Agent & knowledge:** `AgentConfiguration`, `KnowledgeDocument` / versions / chunks, `AgentRun` / `AgentStep` / `ToolCall`, org limits & AI budgets.

**Research:** `ResearchJob`, `ResearchSource`, `ResearchFinding`, `SocialPost`, `TrendSignal`, `Asset`.

**Platform ops:** `Integration`, `SocialConnection`, `AutomationRule`, `WebhookEvent`, `AuditLog`, `FailedJob`, `UsageRecord`, `AiExecution`, `Notification`, …

Migrations: always `prisma migrate deploy` on real data — never `db push` against production Supabase (see README).

---

## 12. Infrastructure detail

### 12.1 Postgres (Supabase)

| Use | URL shape |
|-----|-----------|
| **App / worker (Vercel)** | Transaction pooler **port 6543**, `?pgbouncer=true&connection_limit=5&pool_timeout=20` |
| **Migrations** | Direct / session URI (`DIRECT_URL`, often port 5432) |

Password special characters in URLs must be encoded (`!` → `%21`).

The app soft-bumps legacy `connection_limit=1` because Ask polling + JWT revalidation starved the pool (`JWT_SESSION_ERROR`).

### 12.2 Redis (Upstash)

- Use **`rediss://default:TOKEN@….upstash.io:6379`** (TLS).
- Do **not** paste `redis-cli --tls -u …` into `REDIS_URL`.

### 12.3 Vercel

- Build: `prisma generate && next build` (`vercel.json`).
- Env: Production + Preview for secrets (`DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `AUTH_SECRET`, `ENCRYPTION_KEY`, `APP_URL` / `NEXTAUTH_URL` = public site URL, …).
- Sensitive vars cannot be bulk-downloaded; update via dashboard or `vercel env add`.

### 12.4 Worker host

Same git repo. Start: `npm run worker`.

Required env (minimum): `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, AI + research keys used by Ask (Anthropic, Apify, Tavily, YouTube, …).

Queues (`src/jobs/queues.ts`):

| Queue | Purpose |
|-------|---------|
| `follow-ups` | Due follow-up sweeps |
| `agent-runs` | Ask / agent framework (long lock) |
| `maintenance` | Retention + embedding backfill |

Docs: `docs/WORKER.md`.

### 12.5 Local development

Options:

1. Docker Compose (Postgres + Redis)  
2. Embedded Postgres (`npm run db:dev`) + local Redis  
3. Point `.env` at Supabase + Upstash (same as production)

Always run **two** processes for Ask: `npm run dev` and `npm run worker`.

---

## 13. Environment variable map

Canonical lists: `.env.example`, `src/lib/env.ts`, `docs/VERCEL.md`, `docs/SETUP-KEYS-FROM-SCRATCH.md`.

| Category | Examples |
|----------|----------|
| Database | `DATABASE_URL`, `DIRECT_URL` |
| App / auth | `APP_URL`, `NEXTAUTH_URL`, `AUTH_SECRET` / `NEXTAUTH_SECRET` |
| Redis / worker | `REDIS_URL`, `AGENT_RUNS_CONCURRENCY` |
| Crypto / cron | `ENCRYPTION_KEY`, `CRON_SECRET` |
| Admin bootstrap | `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD`, `ADMIN_BOOTSTRAP_SECRET` |
| AI | `AI_PROVIDER`, `ANTHROPIC_API_KEY`, optional Groq/Mistral/DeepSeek/Gemini/OpenAI |
| Research | `YOUTUBE_API_KEY`, `TAVILY_API_KEY`, `APIFY_TOKEN`, Reddit/Exa as needed |
| Messaging / booking | `MANYCHAT_*`, `BOOKING_*`, `DEFAULT_BOOKING_URL` |
| Social OAuth | `INSTAGRAM_*`, `LINKEDIN_*`, `TIKTOK_*` |
| Email | `EMAIL_SMTP_URL`, `EMAIL_FROM` |
| Assets | `BLOB_*` / `S3_*` |

---

## 14. Security model

- Org isolation on every query  
- AES-256-GCM for credentials at rest (`ENCRYPTION_KEY`)  
- Timing-safe webhook secret compares  
- Secrets never logged; lead text treated as untrusted prompt input  
- Opt-out cancels follow-ups / skips AI replies  
- Rate limits on auth-sensitive routes  
- AI monthly caps via `OrganisationAiBudget` + spend gate  

Details: `docs/SECURITY.md`.

---

## 15. Operations cheat sheet

| Task | How |
|------|-----|
| Deploy app | Push `main` → Vercel (or `vercel deploy`) |
| Apply schema | `DIRECT_URL=… npx prisma migrate deploy` |
| Seed platform admin | `npm run seed:admin` or `POST /api/admin/bootstrap` with `x-admin-bootstrap-secret` |
| Create workspace | Admin → Workspaces or `npm run org:create` |
| Fix Ask “stuck” | Ensure worker up + valid `REDIS_URL` |
| Fix login 401 spam | Valid pooler `DATABASE_URL`, pool limit ≥ 5, JWT soft-fail |
| Setup Assistant | Needs valid `ANTHROPIC_API_KEY` on Vercel; proposes agent/knowledge config |
| Health | `/admin/health`, `/api/health`, `/api/health/providers` |

---

## 16. Testing & CI

- **Unit:** `npm test` (Vitest)  
- **E2E:** `npm run test:e2e` (Playwright)  
- **CI:** `.github/workflows/ci.yml` — typecheck, lint, tests on `main` / PRs (Node 22)

---

## 17. Current production topology (this project)

As operated for Shubz69 / Agent Desk:

| Piece | Service |
|-------|---------|
| App | Vercel project `crm-system` → `crm-system-eight-wine.vercel.app` |
| DB | Supabase Postgres (eu-west-2 pooler) |
| Redis | Upstash |
| Worker | Must run separately (local `npm run worker` or Railway/Render/Fly) |
| Repo | `https://github.com/Shubz69/CRM-system-.git` |

---

## 18. Further reading

| Doc | Topic |
|-----|--------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Inbound flow + layers |
| [WORKER.md](./WORKER.md) | Queues and worker deploy |
| [VERCEL.md](./VERCEL.md) | Hosted env checklist |
| [SUPABASE.md](./SUPABASE.md) | Pooler vs direct URLs |
| [AI_AGENT.md](./AI_AGENT.md) / [AI_PROVIDERS.md](./AI_PROVIDERS.md) | Operator + models |
| [SOCIAL_CONNECTIONS.md](./SOCIAL_CONNECTIONS.md) | OAuth publish/listen |
| [MANYCHAT.md](./MANYCHAT.md) | DM webhooks |
| [KNOWLEDGE.md](./KNOWLEDGE.md) | Docs / chunks |
| [ADMIN.md](./ADMIN.md) | Bootstrap, roles, password reset |
| [SECURITY.md](./SECURITY.md) | Hardening |
| [DEPLOYMENT.md](./DEPLOYMENT.md) / [PRODUCTION-CHECKLIST.md](./PRODUCTION-CHECKLIST.md) | Go-live |
| [SETUP-KEYS-FROM-SCRATCH.md](./SETUP-KEYS-FROM-SCRATCH.md) | Keys from zero |
| [WHAT-YOU-NEED-TO-DO.md](./WHAT-YOU-NEED-TO-DO.md) | Manual operator steps |

---

*Last updated to reflect the social-ready Ask pack, JWT/pool hardenings, Setup Assistant behaviour, and the Vercel + Supabase + Upstash + worker split.*
