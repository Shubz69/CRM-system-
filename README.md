# DM Intelligence CRM

Production-oriented CRM that connects Instagram conversations (via ManyChat), uses an AI agent to qualify leads, books calls, follows up automatically, and turns conversation data into sales and content insights.

Temporary product name: **DM Intelligence CRM** (easy to rename later).

## Stack

- Next.js App Router + TypeScript (strict)
- PostgreSQL + Prisma
- Auth.js / NextAuth (credentials)
- Redis + BullMQ (with in-process fallback when Redis is down)
- Zod validation
- Vitest + Playwright
- Docker Compose for Postgres/Redis (recommended)
- Optional embedded Postgres for local setup without Docker (install separately — see below)

## Quick start (Windows / local without Docker)

```bash
npm install
# Embedded Postgres is optional and platform-specific (kept out of package.json for Vercel):
npm install -D embedded-postgres @embedded-postgres/windows-x64
# Linux local: npm install -D embedded-postgres @embedded-postgres/linux-x64
copy .env.example .env

# Terminal 1 — embedded Postgres
npm run db:dev

# Terminal 2 — schema + seed + app
npm run db:setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

**Demo login:** `demo@dminelligence.local` / `demo1234`

**Super admin** (after seed — never hard-code the password):

```bash
export ADMIN_EMAIL="1230shobhit@gmail.com"
export ADMIN_INITIAL_PASSWORD="your-strong-password"
export ADMIN_FORCE_PASSWORD_CHANGE="true"
npm run seed:admin
```

Then sign in at `/login` and complete `/account/change-password` when forced.

Docs: [SETUP](docs/SETUP.md) · [ADMIN](docs/ADMIN.md) · [MANYCHAT](docs/MANYCHAT.md) · [AI_AGENT](docs/AI_AGENT.md) · [KNOWLEDGE](docs/KNOWLEDGE.md) · [BOOKINGS](docs/BOOKINGS.md) · [SECURITY](docs/SECURITY.md) · [TESTING](docs/TESTING.md) · [DEPLOYMENT](docs/DEPLOYMENT.md)

Then open **Simulator**, send a DM, and confirm the conversation appears in **Inbox**.

## Quick start (Docker)

```bash
docker compose up -d
copy .env.example .env
# Set DATABASE_URL to:
# postgresql://dmintel:dmintel@localhost:5432/dm_intelligence_crm?schema=public
npm install
npm run db:setup
npm run dev
npm run worker
```

## First vertical slice

1. Simulated Instagram DM → `/api/simulator`
2. Webhook-style processing with idempotency
3. Contact + conversation + message upsert
4. Knowledge retrieval
5. AI structured analysis (Zod-validated)
6. Lead scoring + pipeline stage update
7. Mock ManyChat outbound reply
8. Inbox display + pause/resume AI + stage moves

## Main routes

| Area | Path |
|------|------|
| Dashboard | `/dashboard` |
| Inbox | `/inbox` |
| Pipeline | `/pipeline` |
| Contacts | `/contacts` |
| Knowledge | `/knowledge` |
| AI Agent | `/agent` |
| Insights | `/insights` |
| Automations | `/automations` |
| Reports | `/reports` |
| Simulator | `/simulator` |
| Settings | `/settings` |

## Important APIs

- `POST /api/webhooks/manychat` — inbound ManyChat events (`x-manychat-secret`)
- `POST /api/webhooks/booking` — booking provider events (`x-booking-secret`)
- `POST /api/simulator` — authenticated conversation simulator
- `GET /api/dashboard` — live org metrics
- `GET/PATCH /api/conversations/:id` — inbox detail + human controls
- `GET/PATCH /api/pipeline` — kanban/table moves
- `GET/POST /api/bookings` — booking create/list
- `GET /api/insights` — aggregated insights
- `GET /api/reports?type=daily|weekly` — report generation

## AI providers

Set `AI_PROVIDER` to:

- `mock` (default, no API key, deterministic local analysis)
- `openai` (+ `OPENAI_API_KEY`)
- `anthropic` (+ `ANTHROPIC_API_KEY`)

Unsafe/invalid AI JSON is repaired once; if still invalid, the conversation is marked for human review and no reply is sent.

## ManyChat

Live ManyChat logic lives in `src/adapters/messaging/`. Undocumented endpoints are not invented. Local/dev uses the mock transport which records outbound messages in memory.

## Testing

```bash
npm test
npm run typecheck
npm run lint
npx playwright install chromium
npm run test:e2e
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Integrations](docs/INTEGRATIONS.md)
- [Vercel deployment](docs/VERCEL.md)

## Phase status

**Phase 1:** complete and verified (simulator → pipeline → AI → inbox → dashboard).

**Phase 2:** complete (qualification builder, automations engine, notifications, opt-out, booking adapters, assignment, follow-ups, multi-org switch).

**Phase 3:** complete in working form (insights aggregation + UI, content/ad idea APIs, reports POST/CSV/Sheets/email adapters, campaign attribution, health checks). Live Sheets/email/ManyChat/OpenAI remain credential-gated.

See `docs/PHASE-AUDIT.md` for evidence-based status.