/**
 * Forward migration: reconcile schema ↔ migration drift + ledger FK Restrict.
 *
 * Does NOT edit prior migrations. Idempotent (IF NOT EXISTS / DROP IF EXISTS).
 *
 * CANNOT FIX (say plainly): empty-DB `migrate deploy` still fails inside
 * `20260812130000_require_org_on_ledger_tables` because that file UPDATEs
 * FailedJob / UsageRecord / AiExecution without CREATE TABLE. A later
 * migration never runs until that one succeeds. Greenfield workaround:
 * create those three tables (or apply this SQL's CREATE TABLE block) before
 * re-running deploy, or baseline from a db-push'ed schema. Do not quietly
 * edit 20260812130000 if it is already applied in production (checksum).
 */

-- ---------------------------------------------------------------------------
-- Enums missing from init
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "OrganisationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AutopilotMode" AS ENUM ('OFF', 'TEST', 'LIVE', 'PAUSED', 'ATTENTION_REQUIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AuditLogScope" AS ENUM ('ORG', 'PLATFORM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "MemberRole" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "WebhookProcessingStatus" ADD VALUE IF NOT EXISTS 'IGNORED';
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AI_FAILURE';
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_FAILURE';
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AUTOMATION_FAILURE';
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'UNASSIGNED_QUALIFIED';
EXCEPTION WHEN others THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Organisation / User / Conversation columns missing from init
-- ---------------------------------------------------------------------------
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "isPlatform" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "status" "OrganisationStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "plan" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "autopilotMode" "AutopilotMode" NOT NULL DEFAULT 'LIVE';
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "autopilotConfig" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3);

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isSuspended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastInboundAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastOutboundAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "messagingWindowExpiresAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "humanMessagingWindowExpiresAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "handoffReason" TEXT;

ALTER TABLE "QualificationField" ADD COLUMN IF NOT EXISTS "fieldType" TEXT NOT NULL DEFAULT 'short_text';
ALTER TABLE "QualificationField" ADD COLUMN IF NOT EXISTS "options" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "QualificationField" ADD COLUMN IF NOT EXISTS "disqualifyingAnswers" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "isDraft" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "publishedVersion" INTEGER;
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "optOutKeywords" JSONB NOT NULL DEFAULT '["stop","unsubscribe","opt out"]';
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "escalationInstructions" TEXT;
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "lastEditedById" TEXT;
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "lastPublishedById" TEXT;
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Tables never created in migration history (schema-only / db push)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SystemSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SystemSetting_key_key" ON "SystemSetting"("key");

CREATE TABLE IF NOT EXISTS "KnowledgeRecommendation" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "conversationId" TEXT,
    "question" TEXT NOT NULL,
    "draftAnswer" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeRecommendation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "KnowledgeRecommendation_organisationId_status_idx"
  ON "KnowledgeRecommendation"("organisationId", "status");
DO $$ BEGIN
  ALTER TABLE "KnowledgeRecommendation"
    ADD CONSTRAINT "KnowledgeRecommendation_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "LeadScoreEvent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "previousScore" INTEGER NOT NULL,
    "newScore" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "ruleKey" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadScoreEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LeadScoreEvent_leadId_createdAt_idx"
  ON "LeadScoreEvent"("leadId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "LeadScoreEvent"
    ADD CONSTRAINT "LeadScoreEvent_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "FailedJob" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "FailedJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "FailedJob_queue_createdAt_idx" ON "FailedJob"("queue", "createdAt");
CREATE INDEX IF NOT EXISTS "FailedJob_organisationId_createdAt_idx"
  ON "FailedJob"("organisationId", "createdAt");

CREATE TABLE IF NOT EXISTS "UsageRecord" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "UsageRecord_organisationId_feature_createdAt_idx"
  ON "UsageRecord"("organisationId", "feature", "createdAt");

CREATE TABLE IF NOT EXISTS "AiExecution" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "feature" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "estimatedCost" DOUBLE PRECISION,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiExecution_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiExecution_organisationId_createdAt_idx"
  ON "AiExecution"("organisationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiExecution_provider_model_createdAt_idx"
  ON "AiExecution"("provider", "model", "createdAt");
CREATE INDEX IF NOT EXISTS "AiExecution_taskType_createdAt_idx"
  ON "AiExecution"("taskType", "createdAt");
CREATE INDEX IF NOT EXISTS "AiExecution_success_createdAt_idx"
  ON "AiExecution"("success", "createdAt");

-- ---------------------------------------------------------------------------
-- ContactIdentifier: org-scoped unique (replace global unique)
-- ---------------------------------------------------------------------------
ALTER TABLE "ContactIdentifier" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;

UPDATE "ContactIdentifier" ci
SET "organisationId" = c."organisationId"
FROM "Contact" c
WHERE c.id = ci."contactId"
  AND (ci."organisationId" IS NULL OR ci."organisationId" = '');

DELETE FROM "ContactIdentifier" WHERE "organisationId" IS NULL;

ALTER TABLE "ContactIdentifier" ALTER COLUMN "organisationId" SET NOT NULL;

ALTER TABLE "ContactIdentifier" DROP CONSTRAINT IF EXISTS "ContactIdentifier_channel_identifier_key";
DROP INDEX IF EXISTS "ContactIdentifier_channel_identifier_key";

DO $$ BEGIN
  ALTER TABLE "ContactIdentifier"
    ADD CONSTRAINT "ContactIdentifier_organisationId_channel_identifier_key"
    UNIQUE ("organisationId", "channel", "identifier");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ContactIdentifier_organisationId_idx"
  ON "ContactIdentifier"("organisationId");

-- ---------------------------------------------------------------------------
-- Attribution.organisationId + index + FK
-- ---------------------------------------------------------------------------
ALTER TABLE "Attribution" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;

UPDATE "Attribution" a
SET "organisationId" = c."organisationId"
FROM "Contact" c
WHERE c.id = a."contactId"
  AND (a."organisationId" IS NULL OR a."organisationId" = '');

DELETE FROM "Attribution" WHERE "organisationId" IS NULL;

DO $$ BEGIN
  ALTER TABLE "Attribution" ALTER COLUMN "organisationId" SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "Attribution_organisationId_createdAt_idx"
  ON "Attribution"("organisationId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "Attribution"
    ADD CONSTRAINT "Attribution_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Note: org index + FK (column existed in init without FK/index)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Note_organisationId_createdAt_idx"
  ON "Note"("organisationId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "Note"
    ADD CONSTRAINT "Note_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- AuditLog.scope + CHECK (idempotent if 20260812130000 already applied)
-- ---------------------------------------------------------------------------
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "scope" "AuditLogScope";

UPDATE "AuditLog"
SET "scope" = CASE
  WHEN "organisationId" IS NULL THEN 'PLATFORM'::"AuditLogScope"
  ELSE 'ORG'::"AuditLogScope"
END
WHERE "scope" IS NULL;

ALTER TABLE "AuditLog" ALTER COLUMN "scope" SET DEFAULT 'ORG'::"AuditLogScope";
ALTER TABLE "AuditLog" ALTER COLUMN "scope" SET NOT NULL;

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_scope_organisation_check";
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_scope_organisation_check" CHECK (
    ("scope" = 'ORG' AND "organisationId" IS NOT NULL)
    OR ("scope" = 'PLATFORM' AND "organisationId" IS NULL)
  );

CREATE INDEX IF NOT EXISTS "AuditLog_scope_createdAt_idx"
  ON "AuditLog"("scope", "createdAt");

-- ---------------------------------------------------------------------------
-- WebhookEvent.organisationId NOT NULL (backfill orphans to platform org)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  platform_id TEXT;
BEGIN
  SELECT "id" INTO platform_id FROM "Organisation" WHERE "slug" = 'dm-intelligence-platform' LIMIT 1;
  IF platform_id IS NULL THEN
    SELECT "id" INTO platform_id FROM "Organisation" WHERE "isPlatform" IS TRUE LIMIT 1;
  END IF;
  IF platform_id IS NULL THEN
    platform_id := 'plat_drift_reconcile_backfill';
    INSERT INTO "Organisation" (
      "id", "name", "slug", "timezone", "dataRetentionDays", "demoData",
      "isPlatform", "createdAt", "updatedAt"
    ) VALUES (
      platform_id, 'DM Intelligence Platform', 'dm-intelligence-platform',
      'UTC', 365, false, true, NOW(), NOW()
    )
    ON CONFLICT ("slug") DO UPDATE SET "isPlatform" = true;
    SELECT "id" INTO platform_id FROM "Organisation" WHERE "slug" = 'dm-intelligence-platform';
  END IF;

  UPDATE "WebhookEvent" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "FailedJob" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "UsageRecord" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
  UPDATE "AiExecution" SET "organisationId" = platform_id WHERE "organisationId" IS NULL;
END $$;

ALTER TABLE "WebhookEvent" ALTER COLUMN "organisationId" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Ledger FKs: ON DELETE RESTRICT (drop CASCADE / SET NULL, recreate)
-- Operational children keep CASCADE. Ledgers must be exported then purged.
-- ---------------------------------------------------------------------------
ALTER TABLE "WebhookEvent" DROP CONSTRAINT IF EXISTS "WebhookEvent_organisationId_fkey";
ALTER TABLE "WebhookEvent"
  ADD CONSTRAINT "WebhookEvent_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_organisationId_fkey";
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FailedJob" DROP CONSTRAINT IF EXISTS "FailedJob_organisationId_fkey";
ALTER TABLE "FailedJob"
  ADD CONSTRAINT "FailedJob_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UsageRecord" DROP CONSTRAINT IF EXISTS "UsageRecord_organisationId_fkey";
ALTER TABLE "UsageRecord"
  ADD CONSTRAINT "UsageRecord_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AiExecution" DROP CONSTRAINT IF EXISTS "AiExecution_organisationId_fkey";
ALTER TABLE "AiExecution"
  ADD CONSTRAINT "AiExecution_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Platform-org delete triggers (idempotent)
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
