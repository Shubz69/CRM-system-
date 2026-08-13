# Database migrations

**Only path to apply schema:** `npx prisma migrate deploy` (or `npm run db:migrate:deploy` / `npm run db:setup`).

`prisma db push` is **blocked** (`npm run db:push` → exits 1). Offline `scripts/apply-schema-upgrade.ts` is retired the same way. Do not recreate either.

## History (greenfield reset, 2026-08-12)

No production database existed, so migration history was deleted and rebuilt:

| Migration | Purpose |
|-----------|---------|
| `20260812170000_init` | Full schema from `schema.prisma` (`prisma migrate diff --from-empty`) |
| `20260812170001_audit_scope_check_and_platform_org_triggers` | SQL-only: `AuditLog_scope_organisation_check` + platform-org delete triggers |

Intent preserved from prior branches: AuditLog `ORG`/`PLATFORM` scope, ledger `organisationId` NOT NULL (except AuditLog), `ON DELETE RESTRICT` on AuditLog / UsageRecord / AiExecution / WebhookEvent / FailedJob, `Organisation.isPlatform`, OrganisationAiBudget, AgentRun / AgentStep / ToolCall, Lead `(organisationId, stageId, updatedAt)` and AgentStep `(organisationId, createdAt)` indexes. Redundant `ContactIdentifier(organisationId)` and `OrganisationAiBudget(organisationId)` indexes dropped (covered by unique constraints).

## Empty database

```bash
# Prefer DIRECT_URL / direct Postgres (port 5432) — not the pooler
npx prisma migrate deploy
npm run db:seed          # optional demo
npm run seed:admin       # optional admin
```

## Prove zero drift (Prisma model)

After `migrate deploy` on an empty database:

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma
```

Expected output: no SQL differences (empty / “No difference detected”).

Without applying first, using a disposable shadow DB:

```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL"
```

SQL-only objects (CHECK constraint, triggers) are intentional and outside `schema.prisma`; they will not appear in that Prisma-level diff.

Redis is required for production workers (follow-ups and agent runs).
