# Testing

## Commands

```bash
npm test              # Vitest unit + integration
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e      # requires app + DB running
```

## Local prerequisites

1. `npm run db:dev` (embedded Postgres) or Docker Compose Postgres
2. `npx prisma migrate deploy` (never `db push` — see [MIGRATIONS.md](./MIGRATIONS.md))
3. `npm run db:seed`
4. `npm run dev`

## Coverage map

| Area | Suite |
|------|-------|
| AI Zod validation + scoring | `tests/ai-and-scoring.test.ts` |
| Mock messaging + permissions | `tests/adapters-and-permissions.test.ts` |
| Booking / Sheets / Email / knowledge chunking | `tests/adapters-extended.test.ts` |
| Inbound pipeline + idempotency + org isolation | `tests/inbound-pipeline.integration.test.ts` |
| Opt-out keywords | `tests/opt-out.test.ts` |
| Automation triggers | `tests/automations.test.ts` |
| Messaging windows | `tests/messaging-window.test.ts` |
| ManyChat secret masking | `tests/manychat-secrets.test.ts` |
| Login → simulator → inbox → pipeline; opt-out; knowledge; reports; insights; org switch | `e2e/smoke.spec.ts` |

## Manual verification checklist

1. Sign in with demo credentials
2. Send simulator DM including pricing + booking intent
3. Confirm inbox shows AI reply, score, objections/questions
4. Pause AI and send manual reply
5. Send "stop" and confirm opt-out + cancelled follow-ups
6. Move lead stage in pipeline
7. Generate daily report and export CSV / Sheets (mock)
8. Create qualification field and confirm it appears
9. Toggle an automation rule
10. Switch organisation via sidebar when multi-org seeded
11. `GET /api/health` returns healthy when Postgres is up
