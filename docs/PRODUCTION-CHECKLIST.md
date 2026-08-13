# Production checklist

- [ ] `AUTH_SECRET` / `NEXTAUTH_SECRET` set to strong random values
- [ ] `ENCRYPTION_KEY` is 64 hex chars unique per environment (app refuses default in production)
- [ ] `DATABASE_URL` points to managed Postgres (UTF-8)
- [ ] `REDIS_URL` available and `npm run worker` runs as a separate process
- [ ] Webhooks require explicit `organisationId` or unique channel mapping (demo fallback only when `DEMO_MODE`)
- [ ] `MANYCHAT_WEBHOOK_SECRET` and `BOOKING_WEBHOOK_SECRET` rotated (app refuses `dev-*` defaults in production)
- [ ] AI provider keys stored only server-side
- [ ] Demo organisation / demo user disabled (`DEMO_MODE=false`; demo login rejected)
- [ ] `DEMO_MODE=false`
- [ ] Migrations applied (`prisma migrate deploy` only — never `db push`)
- [ ] HTTPS terminated in front of the app
- [ ] Rate limiting enabled at edge/proxy as well as app (ManyChat + booking webhooks rate-limited in-app)
- [ ] Backups enabled for Postgres
- [ ] Log redaction verified (no tokens)
- [ ] Opt-out keywords reviewed with legal/compliance
- [ ] Data retention days configured per organisation
- [ ] Playwright + Vitest green in CI
- [x] Health check endpoint monitored (`GET /api/health`)
