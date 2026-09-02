-- Zernio validation provider (additive). Separate from social-prospecting migration
-- because that migration is already in checkpoint commit 3fa9bbe and must not be rewritten.

DO $$ BEGIN
  ALTER TYPE "IntegrationType" ADD VALUE IF NOT EXISTS 'ZERNIO';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ZernioProfile" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "zernioProfileId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  "connectedAccounts" JSONB NOT NULL DEFAULT '[]',
  "lastSyncAt" TIMESTAMP(3),
  "lastError" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ZernioProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ZernioProfile_organisationId_key" ON "ZernioProfile"("organisationId");
CREATE INDEX IF NOT EXISTS "ZernioProfile_zernioProfileId_idx" ON "ZernioProfile"("zernioProfileId");

DO $$ BEGIN
  ALTER TABLE "ZernioProfile"
    ADD CONSTRAINT "ZernioProfile_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
