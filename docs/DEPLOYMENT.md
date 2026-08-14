# Deployment

## Vercel + Supabase

Recommended production stack:

1. **Vercel** — Next.js app ([VERCEL.md](./VERCEL.md))
2. **Supabase** — PostgreSQL ([SUPABASE.md](./SUPABASE.md))
3. **Redis** (optional on Vercel when using `/api/cron` for follow-ups)

## Components

1. **Next.js web app** (`npm run build` / `npm run start`)
2. **PostgreSQL 16+** via **Supabase** (UTF-8)
3. **Redis 7+** for BullMQ when not using the cron fallback
4. **Worker process** (`npm run worker`) or Vercel Cron → `/api/cron`

## Environment

Copy `.env.example`. Required production values:

- `DATABASE_URL` (Supabase — pooled on Vercel, direct for migrations)
- `AUTH_SECRET` / `NEXTAUTH_SECRET`
- `NEXTAUTH_URL` / `APP_URL`
- `ENCRYPTION_KEY`
- `MANYCHAT_WEBHOOK_SECRET`
- `BOOKING_WEBHOOK_SECRET`
- `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` / `ADMIN_FORCE_PASSWORD_CHANGE`
- `ADMIN_BOOTSTRAP_SECRET` (for hosted admin bootstrap)

Optional:

- `REDIS_URL`
- `AI_PROVIDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- `MANYCHAT_API_TOKEN`, `MANYCHAT_API_BASE_URL`
- `DEFAULT_BOOKING_URL` (optional — your real booking page)

## Database

Against Supabase (prefer **direct** connection for migrate deploy):

```bash
npx prisma migrate deploy
npm run seed:admin
npm run db:seed   # only for demo/staging
```

`prisma db push` and `scripts/apply-schema-upgrade.ts` are blocked. See [MIGRATIONS.md](./MIGRATIONS.md).

See [SUPABASE.md](./SUPABASE.md) for dashboard links and connection string formats.
## Processes

```bash
npm run build
npm run start      # web
npm run worker     # queues / follow-ups
```

## Health checks

- `GET /api/health` returns `{ ok, checks.database, checks.redis, demoMode, aiProvider }`
- `GET /login` returns 200
- `GET /api/auth/providers` returns 200
- Postgres accepts connections
- Redis `PING` succeeds (degraded allowed in local/dev)
- Worker logs "ready" or in-process fallback warning (dev only)

## Webhooks

- ManyChat: `POST /api/webhooks/manychat` + `x-manychat-secret`
- Booking: `POST /api/webhooks/booking` + `x-booking-secret`

Always include `organisationId` (or a mapped messaging channel id) in production payloads.

## Notes

Do not deploy with default webhook secrets.
Do not invent undocumented ManyChat endpoints; configure the adapter with confirmed credentials.
