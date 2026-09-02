# Agent Desk — Release Checklist

Use for **every** production release. Architecture: Vercel web + Railway worker (1 replica) + Supabase Postgres + Redis.

**NEVER `prisma db push` in production.**  
**NEVER** add a second BullMQ `agent-runs` worker.  
**NEVER** deploy optional-provider secrets as globally mandatory.

---

## Before merge / deploy

- [ ] `git fetch origin` and confirm intended commit on `main`
- [ ] `LOCAL_HEAD` / PR SHA documented
- [ ] Migration folder inspected (`prisma/migrations/**`) — additive vs destructive called out
- [ ] `npx prisma migrate status` against **production** DB (read-only status OK pre-deploy)
- [ ] `npm run typecheck` → PASS
- [ ] `npm run lint` → **0 errors**
- [ ] `npm test` → **0 failed, 0 skipped** (baseline currently ≥551)
- [ ] If outbox/claim tests touched: re-run `tests/domain-events-outbox.test.ts` ≥3 times
- [ ] No `.env`, secrets, traces, or passwords in the commit
- [ ] Optional connectors (Meta Instagram, Apify, …) validated only in provider-scoped asserts

## Deploy sequence

1. [ ] Merge / push to `origin/main`
2. [ ] Confirm `git ls-remote origin refs/heads/main` SHA
3. [ ] Apply pending migrations **only if needed**: `npx prisma migrate deploy` (direct DB URL)
4. [ ] Confirm migrate status: Database schema is up to date
5. [ ] Wait for Vercel Production deploy of that SHA
6. [ ] Confirm Railway worker redeployed to same SHA (or intentional pin) — **1 replica**
7. [ ] `GET /api/health` → `ok: true`, `database.ok`, `redis.ok`
8. [ ] Spot-check login + `/integrations` + one Ask
9. [ ] Tail Vercel + Railway logs ~**15 minutes** for material backend changes (5xx, Redis circuit, migration errors)

## SHA verification

| Check | Command / place |
|-------|-----------------|
| Remote main | `git ls-remote origin refs/heads/main` |
| Vercel | Deployment detail → commit SHA |
| Railway | Service deploy → commit SHA |
| Must match | Unless hotfix branch explicitly documented |

## After release (soak)

- [ ] No Redis quota storm / worker crash-loop
- [ ] Webhooks: ManyChat (and Meta if configured) not 500ing
- [ ] Outbox / failed-jobs not exploding
- [ ] Hosted Playwright (optional):  
  `PLAYWRIGHT_SKIP_WEBSERVER=1` + `PLAYWRIGHT_BASE_URL=…` + `E2E_ADMIN_*` / `E2E_READONLY_*`  
  → `npx playwright test e2e/hosted-production-acceptance.spec.ts`

## Rollback triggers

- Health failing after deploy
- Auth / DB pool storms
- Migration left schema inconsistent
- Worker crash-loop

→ Follow `QA/PRODUCTION_RUNBOOK.md` (**BAD DEPLOY** / **BAD MIGRATION**).

## Explicit bans

| Ban | Why |
|-----|-----|
| `prisma db push` | Non-versioned schema drift |
| `prisma migrate dev` on prod | Interactive / shadow DB |
| Scaling Railway worker replicas for agent-runs | Duplicate job processing risk |
| Putting optional provider secrets in `assertProductionSecretsConfigured` | Takes down worker + unrelated webhooks |
