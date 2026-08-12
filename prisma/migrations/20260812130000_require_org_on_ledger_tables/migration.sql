-- Org isolation + AuditLog scope.
--
-- Safe pattern for populated tables:
--   1) columns already nullable (or newly added nullable)
--   2) backfill
--   3) SET NOT NULL / CHECK constraints
--
-- AuditLog is intentionally different from other ledger tables:
--   - organisationId stays NULLABLE
--   - orphans become scope=PLATFORM with organisationId NULL (no fake tenant attribution)
-- WebhookEvent / FailedJob / UsageRecord / AiExecution still backfill to platform org.

-- ---------------------------------------------------------------------------
-- Organisation.isPlatform + protected platform org
-- ---------------------------------------------------------------------------
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "isPlatform" BOOLEAN NOT NULL DEFAULT false;

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
      "isPlatform",
      "createdAt",
      "updatedAt"
    ) VALUES (
      platform_id,
      'DM Intelligence Platform',
      'dm-intelligence-platform',
      'UTC',
      365,
      false,
      true,
      NOW(),
      NOW()
    );
  ELSE
    UPDATE "Organisation" SET "isPlatform" = true WHERE "id" = platform_id;
  END IF;

  -- Ledger tables (NOT AuditLog): park orphans under platform org
  UPDATE "WebhookEvent" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "FailedJob" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "UsageRecord" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "AiExecution" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
END $$;

ALTER TABLE "WebhookEvent" ALTER COLUMN "organisationId" SET NOT NULL;
ALTER TABLE "FailedJob" ALTER COLUMN "organisationId" SET NOT NULL;
ALTER TABLE "UsageRecord" ALTER COLUMN "organisationId" SET NOT NULL;
ALTER TABLE "AiExecution" ALTER COLUMN "organisationId" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- AuditLog.scope — orphans become PLATFORM with NULL organisationId
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AuditLogScope') THEN
    CREATE TYPE "AuditLogScope" AS ENUM ('ORG', 'PLATFORM');
  END IF;
END $$;

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "scope" "AuditLogScope";

-- Existing rows with an org → ORG; existing null org → PLATFORM
UPDATE "AuditLog"
SET "scope" = CASE
  WHEN "organisationId" IS NULL THEN 'PLATFORM'::"AuditLogScope"
  ELSE 'ORG'::"AuditLogScope"
END
WHERE "scope" IS NULL;

ALTER TABLE "AuditLog" ALTER COLUMN "scope" SET DEFAULT 'ORG'::"AuditLogScope";
ALTER TABLE "AuditLog" ALTER COLUMN "scope" SET NOT NULL;

-- Keep organisationId nullable (drop NOT NULL if a prior revision set it)
ALTER TABLE "AuditLog" ALTER COLUMN "organisationId" DROP NOT NULL;

-- Conditional invariant Prisma cannot express
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_scope_organisation_check";
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_scope_organisation_check" CHECK (
    ("scope" = 'ORG' AND "organisationId" IS NOT NULL)
    OR ("scope" = 'PLATFORM' AND "organisationId" IS NULL)
  );

CREATE INDEX IF NOT EXISTS "AuditLog_scope_createdAt_idx"
  ON "AuditLog"("scope", "createdAt");

-- ---------------------------------------------------------------------------
-- FKs for ledger tables that previously had no Organisation relation
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Protect platform org from hard/soft delete at the database layer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_platform_org_hard_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD."isPlatform" IS TRUE THEN
    RAISE EXCEPTION 'Cannot delete platform organisation (%)', OLD."slug";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_platform_org_hard_delete ON "Organisation";
CREATE TRIGGER trg_prevent_platform_org_hard_delete
  BEFORE DELETE ON "Organisation"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_platform_org_hard_delete();

CREATE OR REPLACE FUNCTION prevent_platform_org_soft_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD."isPlatform" IS TRUE
     AND NEW."deletedAt" IS NOT NULL
     AND OLD."deletedAt" IS NULL THEN
    RAISE EXCEPTION 'Cannot soft-delete platform organisation (%)', OLD."slug";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_platform_org_soft_delete ON "Organisation";
CREATE TRIGGER trg_prevent_platform_org_soft_delete
  BEFORE UPDATE OF "deletedAt" ON "Organisation"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_platform_org_soft_delete();
