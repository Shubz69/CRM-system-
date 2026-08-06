# Setup

## Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Redis 7+ (optional in local mock mode; required for workers)

## Quick start

```bash
cp .env.example .env
# Edit DATABASE_URL, AUTH_SECRET / NEXTAUTH_SECRET, ENCRYPTION_KEY

npm install
npx prisma generate
npx prisma db push
npm run db:seed          # demo data (requires DEMO_MODE=true)
npm run seed:admin       # optional — requires ADMIN_INITIAL_PASSWORD
npm run dev
```

Open `http://localhost:3000`. Demo login (when seeded): `demo@dminelligence.local` / `demo1234`.

## Environment highlights

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Postgres connection string |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Session signing |
| `DEMO_MODE` | `true` to allow demo seed/login |
| `ADMIN_EMAIL` | Super admin email (default in example) |
| `ADMIN_INITIAL_PASSWORD` | Required for `npm run seed:admin` — leave blank in `.env.example` |
| `ADMIN_FORCE_PASSWORD_CHANGE` | Default `true` |
| `MANYCHAT_WEBHOOK_SECRET` | Inbound webhook verification |
| `ENCRYPTION_KEY` | 64 hex chars for secret-at-rest |

See `.env.example` for the full list and [ADMIN.md](./ADMIN.md) for platform admin seeding.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js dev server |
| `npm run db:push` | Apply Prisma schema |
| `npm run db:seed` | Demo organisation seed |
| `npm run seed:admin` | Idempotent super admin seed |
| `npm run worker` | BullMQ worker process |

## Integrations UI

Configure ManyChat channels under `/integrations` (webhook URL, masked secret, connection status). Messaging channel CRUD uses `/api/messaging-channels`.
