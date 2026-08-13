# Setup

## Prerequisites

- Node.js 20+
- PostgreSQL — **[Supabase](./SUPABASE.md) recommended** for hosted/Preview/Production; local Docker or embedded Postgres is fine for development
- Redis 7+ (optional in local mock mode; required for workers)

## Hosted database (Supabase)

For Vercel and long-term production, create a Supabase project and set `DATABASE_URL`.  
Follow **[SUPABASE.md](./SUPABASE.md)** step by step (dashboard links included).

## Quick start (local)

```bash
cp .env.example .env
# Edit DATABASE_URL (local Postgres or Supabase direct URI), AUTH_SECRET / NEXTAUTH_SECRET, ENCRYPTION_KEY

npm install
npx prisma generate
npx prisma migrate deploy
npm run db:seed          # demo data (requires DEMO_MODE=true)
npm run seed:admin       # optional — requires ADMIN_INITIAL_PASSWORD
npm run dev
```

Open `http://localhost:3000`. Demo login (when seeded): `demo@dminelligence.local` / `demo1234`.

Schema rules: **[MIGRATIONS.md](./MIGRATIONS.md)** — `migrate deploy` only; `db push` is blocked.

## Environment highlights

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Postgres connection string (Supabase pooled for Vercel; direct for `prisma migrate deploy`) |
| `DIRECT_URL` | Optional non-pooled URL for migrations |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Session signing |
| `DEMO_MODE` | `true` to allow demo seed/login |
| `ADMIN_EMAIL` | Super admin email (default in example) |
| `ADMIN_INITIAL_PASSWORD` | Required for `npm run seed:admin` — leave blank in `.env.example` |
| `ADMIN_FORCE_PASSWORD_CHANGE` | Default `true` |
| `ADMIN_BOOTSTRAP_SECRET` | Enables `POST /api/admin/bootstrap` on Vercel |
| `MANYCHAT_WEBHOOK_SECRET` | Inbound webhook verification |
| `ENCRYPTION_KEY` | 64 hex chars for secret-at-rest |

See `.env.example` for the full list, [SUPABASE.md](./SUPABASE.md) for the database, [ADMIN.md](./ADMIN.md) for platform admin seeding, and [VERCEL.md](./VERCEL.md) for deploy.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js dev server |
| `npm run db:migrate:deploy` / `db:setup` | Apply migrations (`migrate deploy`) + seed for setup |
| `npm run db:seed` | Demo organisation seed |
| `npm run seed:admin` | Idempotent super admin seed |
| `npm run worker` | BullMQ worker process |
| `npm run db:push` | **Blocked** — exits with error |

## Integrations UI

Configure ManyChat channels under `/integrations` (webhook URL, masked secret, connection status). Messaging channel CRUD uses `/api/messaging-channels`.
