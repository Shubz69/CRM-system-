# Deployment

## Components

1. **Next.js web app** (`npm run build` / `npm run start`)
2. **PostgreSQL 16+** (UTF-8)
3. **Redis 7+** for BullMQ in production
4. **Worker process** (`npm run worker`)

## Environment

Copy `.env.example`. Required production values:

- `DATABASE_URL`
- `REDIS_URL`
- `AUTH_SECRET` / `NEXTAUTH_SECRET`
- `NEXTAUTH_URL` / `APP_URL`
- `ENCRYPTION_KEY`
- `MANYCHAT_WEBHOOK_SECRET`
- `BOOKING_WEBHOOK_SECRET`

Optional:

- `AI_PROVIDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- `MANYCHAT_API_TOKEN`, `MANYCHAT_API_BASE_URL`
- `DEFAULT_BOOKING_URL`

## Database

```bash
npx prisma migrate deploy
# or for controlled environments:
npx prisma db push
npm run db:seed   # only for demo/staging
```

After additive schema changes without migrate history, local/dev can run:

```bash
npx tsx scripts/apply-schema-upgrade.ts
```

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

Do not deploy with `DEMO_MODE=true` or default demo secrets.
Do not invent undocumented ManyChat endpoints; configure the adapter with confirmed credentials.
