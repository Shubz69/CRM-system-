-- Imaging assets + prompt-confirm pause on AgentRun.

ALTER TYPE "AgentRunStatus" ADD VALUE IF NOT EXISTS 'AWAITING_PROMPT_CONFIRM';

ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "pendingPrompt" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "pendingBrief" JSONB;
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "pendingCostEstimateCents" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "referenceAssetId" TEXT;

CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "prompt" TEXT,
    "derivedFromAssetId" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "mimeType" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'reference',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Asset_organisationId_storageKey_key" ON "Asset"("organisationId", "storageKey");
CREATE INDEX "Asset_organisationId_createdAt_idx" ON "Asset"("organisationId", "createdAt");
CREATE INDEX "Asset_organisationId_kind_createdAt_idx" ON "Asset"("organisationId", "kind", "createdAt");
CREATE INDEX "Asset_derivedFromAssetId_idx" ON "Asset"("derivedFromAssetId");
CREATE INDEX "Asset_createdByUserId_idx" ON "Asset"("createdByUserId");

ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_derivedFromAssetId_fkey"
  FOREIGN KEY ("derivedFromAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AgentRun_referenceAssetId_idx" ON "AgentRun"("referenceAssetId");

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_referenceAssetId_fkey"
  FOREIGN KEY ("referenceAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
