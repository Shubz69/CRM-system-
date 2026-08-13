# Schema ↔ migration drift report (PR #7 follow-up)

Generated against branch `cursor/org-isolation-fixes-668b` before
`20260812160000_reconcile_drift_ledger_restrict`. That forward migration
reconciles what can be fixed without editing prior migration files.

## Recommendation: organisation deletion

**Chosen approach: soft-delete in normal operation + `ON DELETE RESTRICT` on ledger FKs.**

| Option | Verdict |
|--------|---------|
| Soft-delete only | Necessary product path (`Organisation.deletedAt` already exists) but alone does not stop accidental `prisma.organisation.delete()`. |
| `onDelete: Restrict` on ledgers | Seatbelt: hard-delete fails while AuditLog / UsageRecord / AiExecution / WebhookEvent / FailedJob rows exist. Forces export-then-purge. |
| Reassign to platform org | Rejected — mixes tenant billing into platform spend and falsifies ORG audit attribution (PLATFORM audits use `organisationId = null`). |

Cascade remains correct for operational CRM children (conversations, messages, leads, contacts, …).

`AgentRun` is **not** on this PR (Prompt 2B). When that ships, use the same Restrict pattern.

API: `POST /api/admin/workspaces` action `archive` → soft-delete. Hard purge is `purgeOrganisationHard()` in `src/services/organisation-lifecycle.ts` (confirm slug, wipe ledgers explicitly, then delete org).

---

## What `prisma migrate deploy` from empty produces (before this forward migration)

| Step | Result |
|------|--------|
| `20260805140000_init` | Applies |
| `20260812130000_require_org_on_ledger_tables` | **Fails** (`relation "FailedJob" does not exist`) |
| Later migrations | Never run |

So a migrate-only empty database keeps **init only**: no ledger tables, no `AuditLog.scope`, WebhookEvent org still nullable, ContactIdentifier still globally unique, etc.

### Cannot be fixed by a later migration alone

`20260812130000` UPDATEs `FailedJob` / `UsageRecord` / `AiExecution` without CREATE TABLE. Prisma will not apply `20260812160000_…` until that migration succeeds. **Editing `20260812130000` is forbidden** once it may be applied in any environment (checksum risk).

**Greenfield workaround (ops):** create the three ledger tables (or run the CREATE TABLE block from `20260812160000_…`) then re-run `migrate deploy`; or baseline from a db-push schema. Do not paper over this.

---

## Drift inventory

For each item: (A) schema, (B) migration history, (C) after empty migrate deploy, (D) after applying `20260812160000` on a DB that can reach it.

### Critical — user-called-out

| Item | Schema (A) | Migrations (B) | Empty deploy (C) | Forward mig (D) |
|------|------------|----------------|------------------|-----------------|
| **ContactIdentifier unique** | `UNIQUE (organisationId, channel, identifier)`; org column NOT NULL | Init: no org column; `UNIQUE (channel, identifier)` only | Global unique; no org column | Adds org column, backfill, drops global unique, adds org unique + index |
| **Note indexes / FK** | `@@index([organisationId, createdAt])` + org FK Cascade | Init: org column present; **no** org index; **no** org FK | Same as init | Adds index + FK |
| **Attribution org** | `organisationId` NOT NULL + index + FK | Init: **no** `organisationId` | Prisma writes fail | Adds column, backfill, NOT NULL, index, FK |
| **FailedJob / UsageRecord / AiExecution CREATE** | Full models | **Never CREATE TABLE**; mig2 UPDATEs them | Mig2 aborts; tables missing | `CREATE TABLE IF NOT EXISTS` + Restrict FKs |
| **WebhookEvent FK** | NOT NULL + was Cascade → now **Restrict** | Init: nullable + **SET NULL**; mig2: SET NOT NULL, FK unchanged | Nullable + SET NULL | NOT NULL + **RESTRICT** |
| **AuditLog FK** | nullable org + scope; was Cascade → now **Restrict** | Init: SET NULL, no scope; mig2: scope+CHECK, FK still SET NULL | Init only if mig2 failed | scope+CHECK + **RESTRICT** |

### Other schema-ahead-of-migrations (reconciled in forward mig)

| Item | Severity | Forward mig action |
|------|----------|-------------------|
| Enums: `OrganisationStatus`, `AutopilotMode`, `AuditLogScope` | Blocks features | CREATE TYPE IF needed |
| `MemberRole.SUPER_ADMIN`, webhook `IGNORED`, notification failure types | Blocks / runtime enum errors | `ADD VALUE IF NOT EXISTS` |
| Organisation: `isPlatform`, `status`, `plan`, `autopilotMode`, `autopilotConfig`, `lastActivityAt` | Blocks admin/autopilot | ADD COLUMN IF NOT EXISTS |
| User: admin/lockout columns | Blocks seed-admin / auth | ADD COLUMN IF NOT EXISTS |
| Conversation messaging-window columns | Blocks window features | ADD COLUMN IF NOT EXISTS |
| QualificationField `fieldType` / options / disqualifyingAnswers | Blocks qualification admin | ADD COLUMN IF NOT EXISTS |
| AgentConfiguration draft/publish/language/optOut/… | Blocks agent settings | ADD COLUMN IF NOT EXISTS |
| `KnowledgeRecommendation`, `LeadScoreEvent`, `SystemSetting` | Blocks related APIs | CREATE TABLE IF NOT EXISTS |
| Platform-org delete triggers | Silent wrong if missing | CREATE OR REPLACE + triggers |
| AuditLog CHECK `AuditLog_scope_organisation_check` | SQL-only (intentional) | Recreate idempotently |

### Intentional SQL-only (not in Prisma schema)

- `AuditLog_scope_organisation_check`
- `trg_prevent_platform_org_hard_delete` / `trg_prevent_platform_org_soft_delete`

### Redundant / not fixed here

- `ContactIdentifier @@index([organisationId])` is redundant with the unique leftmost prefix — left as schema declares for clarity.
- AgentConfiguration init defaults (`mock`) vs schema (`anthropic`) — column defaults only for new rows; not rewritten in place (would surprise existing orgs).

### `scripts/apply-schema-upgrade.ts`

Partial offline bridge (ContactIdentifier, Attribution column, some enums/agent cols). **Not** part of `migrate deploy`. Prefer the forward migration going forward; keep the script for emergency local repair only.

---

## Production note

If `_prisma_migrations` already has `20260812130000_require_org_on_ledger_tables` with a **different checksum** than the file on disk (file was edited after apply), do **not** re-edit that file — use this forward migration only and resolve checksum via Prisma’s documented repair flow if needed.
