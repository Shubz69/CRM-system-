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
npm run db:seed          # platform organisation only
npm run seed:admin       # requires ADMIN_EMAIL + ADMIN_INITIAL_PASSWORD
npx tsx scripts/create-organisation.ts --name "Your Agency" --slug your-agency --owner-email you@example.com
npm run dev
```

Open `http://localhost:3000` and sign in with your admin email.

Schema rules: **[MIGRATIONS.md](./MIGRATIONS.md)** — `migrate deploy` only; `db push` is blocked.

## Environment highlights

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Postgres connection string (Supabase pooled for Vercel; direct for `prisma migrate deploy`) |
| `DIRECT_URL` | Optional non-pooled URL for migrations |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Session signing |
| `ADMIN_EMAIL` | Super admin email |
| `ADMIN_INITIAL_PASSWORD` | Used only by `seed:admin` / bootstrap |
| `DEFAULT_BOOKING_URL` | Optional default when an agent has no booking URL |
| `AI_PROVIDER` | `anthropic` (default) or `mock` in local/test |
| `MANYCHAT_*` | Live Instagram DM delivery |
| `APIFY_TOKEN` | Licensed social listening sources |

See `.env.example` for the full list.
