-- Social Prospecting + Outreach OS (Ayrshare + LinkedIn V1/V2 readiness)
-- ADDITIVE ONLY — do not apply to production from this pass without explicit operator approval.

DO $$ BEGIN
  ALTER TYPE "IntegrationType" ADD VALUE IF NOT EXISTS 'AYRSHARE';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "BusinessOpportunityType" ADD VALUE IF NOT EXISTS 'SOCIAL_PROSPECT';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SocialProspectStatus" AS ENUM (
    'DISCOVERED',
    'RESEARCHED',
    'QUALIFIED',
    'OUTREACH_READY',
    'CONNECTION_READY',
    'CONNECTION_SENT',
    'CONNECTED',
    'FOLLOWUP_READY',
    'MESSAGE_SENT',
    'REPLIED',
    'QUALIFIED_LEAD',
    'OPPORTUNITY',
    'WON',
    'LOST',
    'DISMISSED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SocialNetworkKind" AS ENUM (
    'LINKEDIN',
    'INSTAGRAM',
    'X',
    'TIKTOK',
    'FACEBOOK',
    'YOUTUBE',
    'THREADS',
    'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- If enum already existed without X/THREADS (partial prior apply), add values safely
DO $$ BEGIN
  ALTER TYPE "SocialNetworkKind" ADD VALUE IF NOT EXISTS 'X';
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "SocialNetworkKind" ADD VALUE IF NOT EXISTS 'THREADS';
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SocialActionMode" AS ENUM (
    'HUMAN_ACTION_REQUIRED',
    'PROVIDER_API',
    'REQUIRES_PROVIDER_APPROVAL',
    'PROVIDER_WINDOW_REQUIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "AyrshareProfile" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "ayrshareProfileId" TEXT,
  "encryptedProfileKey" TEXT,
  "connectedNetworks" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  "lastSyncAt" TIMESTAMP(3),
  "lastError" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AyrshareProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AyrshareProfile_organisationId_key" ON "AyrshareProfile"("organisationId");
CREATE INDEX IF NOT EXISTS "AyrshareProfile_ayrshareProfileId_idx" ON "AyrshareProfile"("ayrshareProfileId");

CREATE TABLE IF NOT EXISTS "SocialProspect" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "status" "SocialProspectStatus" NOT NULL DEFAULT 'DISCOVERED',
  "personName" TEXT,
  "companyName" TEXT,
  "role" TEXT,
  "companyWebsite" TEXT,
  "location" TEXT,
  "linkedinUrl" TEXT,
  "instagramUrl" TEXT,
  "otherSocialUrls" JSONB NOT NULL DEFAULT '[]',
  "socialIdentities" JSONB NOT NULL DEFAULT '[]',
  "sourceEvidence" JSONB NOT NULL DEFAULT '[]',
  "sourceQuality" TEXT,
  "confidence" DOUBLE PRECISION,
  "fitScore" DOUBLE PRECISION,
  "reasonSelected" TEXT,
  "uncertaintyFlags" JSONB NOT NULL DEFAULT '[]',
  "preferredNetworks" JSONB NOT NULL DEFAULT '[]',
  "icpSnapshot" JSONB NOT NULL DEFAULT '{}',
  "researchJobId" TEXT,
  "contactId" TEXT,
  "companyId" TEXT,
  "opportunityId" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialProspect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialProspect_organisationId_dedupeKey_key" ON "SocialProspect"("organisationId", "dedupeKey");
CREATE INDEX IF NOT EXISTS "SocialProspect_organisationId_status_fitScore_idx" ON "SocialProspect"("organisationId", "status", "fitScore");
CREATE INDEX IF NOT EXISTS "SocialProspect_organisationId_retrievedAt_idx" ON "SocialProspect"("organisationId", "retrievedAt");
CREATE INDEX IF NOT EXISTS "SocialProspect_contactId_idx" ON "SocialProspect"("contactId");

CREATE TABLE IF NOT EXISTS "SocialOutreachThread" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "prospectId" TEXT NOT NULL,
  "contactId" TEXT,
  "network" "SocialNetworkKind" NOT NULL,
  "status" "SocialProspectStatus" NOT NULL DEFAULT 'OUTREACH_READY',
  "actionMode" "SocialActionMode" NOT NULL DEFAULT 'HUMAN_ACTION_REQUIRED',
  "connectionNote" TEXT,
  "followUpOne" TEXT,
  "followUpTwo" TEXT,
  "profileUrl" TEXT,
  "providerSent" BOOLEAN NOT NULL DEFAULT false,
  "markedConnectionSentAt" TIMESTAMP(3),
  "markedConnectedAt" TIMESTAMP(3),
  "markedFollowUpSentAt" TIMESTAMP(3),
  "lastOutcome" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialOutreachThread_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SocialOutreachThread_organisationId_network_status_idx" ON "SocialOutreachThread"("organisationId", "network", "status");
CREATE INDEX IF NOT EXISTS "SocialOutreachThread_prospectId_idx" ON "SocialOutreachThread"("prospectId");
CREATE INDEX IF NOT EXISTS "SocialOutreachThread_contactId_idx" ON "SocialOutreachThread"("contactId");

CREATE TABLE IF NOT EXISTS "SocialProviderUsage" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "network" TEXT,
  "capability" TEXT NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 1,
  "costCents" INTEGER,
  "latencyMs" INTEGER,
  "errorCode" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialProviderUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SocialProviderUsage_organisationId_provider_createdAt_idx" ON "SocialProviderUsage"("organisationId", "provider", "createdAt");
CREATE INDEX IF NOT EXISTS "SocialProviderUsage_organisationId_capability_createdAt_idx" ON "SocialProviderUsage"("organisationId", "capability", "createdAt");

CREATE TABLE IF NOT EXISTS "SocialMetricFact" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "externalPostId" TEXT,
  "metric" TEXT NOT NULL,
  "value" DOUBLE PRECISION,
  "source" TEXT NOT NULL,
  "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialMetricFact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialMetricFact_organisationId_platform_externalPostId_metric_source_retrievedAt_key"
  ON "SocialMetricFact"("organisationId", "platform", "externalPostId", "metric", "source", "retrievedAt");
CREATE INDEX IF NOT EXISTS "SocialMetricFact_organisationId_platform_retrievedAt_idx"
  ON "SocialMetricFact"("organisationId", "platform", "retrievedAt");

DO $$ BEGIN
  ALTER TABLE "AyrshareProfile"
    ADD CONSTRAINT "AyrshareProfile_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialProspect"
    ADD CONSTRAINT "SocialProspect_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialProspect"
    ADD CONSTRAINT "SocialProspect_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialOutreachThread"
    ADD CONSTRAINT "SocialOutreachThread_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialOutreachThread"
    ADD CONSTRAINT "SocialOutreachThread_prospectId_fkey"
    FOREIGN KEY ("prospectId") REFERENCES "SocialProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialOutreachThread"
    ADD CONSTRAINT "SocialOutreachThread_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialProviderUsage"
    ADD CONSTRAINT "SocialProviderUsage_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialMetricFact"
    ADD CONSTRAINT "SocialMetricFact_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
