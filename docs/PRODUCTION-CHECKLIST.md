# Production checklist

- [ ] `AUTH_SECRET` / `NEXTAUTH_SECRET` set to strong random values
- [ ] `ENCRYPTION_KEY` is 64 hex chars unique per environment (app refuses default in production)
- [ ] `DATABASE_URL` points to managed Postgres (UTF-8)
- [ ] `REDIS_URL` available. **DEEP Ask** needs `npm run worker` as a **separate Railway/Render process** with the same Redis URL + prefix as Vercel. **QUICK Ask** runs in the web process and must not depend on that worker.
- [ ] Admin → AI Ops shows **Hosted worker live** (heartbeat), not only “Redis OK”
- [ ] Webhooks require explicit `organisationId` or unique channel mapping (no demo fallback)
- [ ] `MANYCHAT_WEBHOOK_SECRET` and `BOOKING_WEBHOOK_SECRET` rotated (app refuses `dev-*` defaults in production)
- [ ] AI provider keys stored only server-side
- [ ] No demo organisation / demo user in the database
- [ ] Migrations applied (`prisma migrate deploy` only — never `db push`)
- [ ] HTTPS terminated in front of the app
- [ ] Rate limiting enabled at edge/proxy as well as app (ManyChat + booking webhooks rate-limited in-app)
- [ ] Backups enabled for Postgres
- [ ] Log redaction verified (no tokens)
- [ ] Opt-out keywords reviewed with legal/compliance
- [ ] Data retention days configured per organisation
- [ ] Playwright + Vitest green in CI
- [x] Health check endpoint monitored (`GET /api/health`)
