# Production checklist

- [ ] `AUTH_SECRET` / `NEXTAUTH_SECRET` set to strong random values
- [ ] `ENCRYPTION_KEY` is 64 hex chars unique per environment
- [ ] `DATABASE_URL` points to managed Postgres (UTF-8)
- [ ] `REDIS_URL` available and `npm run worker` runs as a separate process
- [ ] Webhooks require explicit `organisationId` or channel mapping (no demo fallback)
- [ ] `MANYCHAT_WEBHOOK_SECRET` and `BOOKING_WEBHOOK_SECRET` rotated
- [ ] AI provider keys stored only server-side
- [ ] Demo organisation / demo user disabled or removed
- [ ] `DEMO_MODE=false`
- [ ] Migrations applied (`prisma migrate deploy` or approved `db push` process)
- [ ] HTTPS terminated in front of the app
- [ ] Rate limiting enabled at edge/proxy as well as app
- [ ] Backups enabled for Postgres
- [ ] Log redaction verified (no tokens)
- [ ] Opt-out keywords reviewed with legal/compliance
- [ ] Data retention days configured per organisation
- [ ] Playwright + Vitest green in CI
- [ ] Health check endpoint monitored
