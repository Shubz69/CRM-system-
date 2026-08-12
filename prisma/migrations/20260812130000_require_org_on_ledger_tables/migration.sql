-- Require organisationId on ledger / event tables.
--
-- Backfill strategy: attach orphan rows to the platform organisation
-- (slug = dm-intelligence-platform), creating it if needed.
--
-- Rows that legitimately had no tenant (explained before forcing NOT NULL):
-- - AuditLog: platform SystemSetting updates, password-reset, admin seed
-- - FailedJob: BullMQ worker-level failures without a follow-up row
-- - UsageRecord / AiExecution: rare writes that omitted org
-- - WebhookEvent: should already have org from inbound; any orphans → platform
--
-- These are reassigned to the platform org rather than deleted so audit history
-- is preserved. Application writers now require an organisationId (using the
-- platform org helper for true platform events).

DO $$
DECLARE
  platform_id TEXT;
BEGIN
  SELECT "id" INTO platform_id FROM "Organisation" WHERE "slug" = 'dm-intelligence-platform' LIMIT 1;

  IF platform_id IS NULL THEN
    platform_id := 'plat_org_isolation_backfill';
    INSERT INTO "Organisation" (
      "id",
      "name",
      "slug",
      "timezone",
      "dataRetentionDays",
      "demoData",
      "createdAt",
      "updatedAt"
    ) VALUES (
      platform_id,
      'DM Intelligence Platform',
      'dm-intelligence-platform',
      'UTC',
      365,
      false,
      NOW(),
      NOW()
    );
  END IF;

  UPDATE "WebhookEvent" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "AuditLog" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "FailedJob" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "UsageRecord" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "AiExecution" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
END $$;

ALTER TABLE "WebhookEvent" ALTER COLUMN "organisationId" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "organisationId" SET NOT NULL;
ALTER TABLE "FailedJob" ALTER COLUMN "organisationId" SET NOT NULL;
ALTER TABLE "UsageRecord" ALTER COLUMN "organisationId" SET NOT NULL;
ALTER TABLE "AiExecution" ALTER COLUMN "organisationId" SET NOT NULL;

-- Attach FK relations for ledger tables that previously had no Organisation relation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FailedJob_organisationId_fkey'
  ) THEN
    ALTER TABLE "FailedJob"
      ADD CONSTRAINT "FailedJob_organisationId_fkey"
      FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UsageRecord_organisationId_fkey'
  ) THEN
    ALTER TABLE "UsageRecord"
      ADD CONSTRAINT "UsageRecord_organisationId_fkey"
      FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiExecution_organisationId_fkey'
  ) THEN
    ALTER TABLE "AiExecution"
      ADD CONSTRAINT "AiExecution_organisationId_fkey"
      FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "FailedJob_organisationId_createdAt_idx"
  ON "FailedJob"("organisationId", "createdAt");
