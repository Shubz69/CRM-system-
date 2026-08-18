-- Multi-tenant "Social Connections" layer: lets an organisation OAuth-connect its own
-- Instagram / LinkedIn / TikTok account for listening + publishing capabilities.
-- Distinct from MessagingChannel (the existing ManyChat-mediated Instagram DM channel)
-- and from SocialPost.platform (a free-text string used by the research/listening
-- pipeline). See docs/SOCIAL_CONNECTIONS.md.

CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'LINKEDIN', 'TIKTOK');
CREATE TYPE "SocialConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');

CREATE TABLE "SocialConnection" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "SocialConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "connectedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialConnection_organisationId_platform_externalAccountId_key" ON "SocialConnection"("organisationId", "platform", "externalAccountId");
CREATE INDEX "SocialConnection_organisationId_idx" ON "SocialConnection"("organisationId");

ALTER TABLE "SocialConnection"
  ADD CONSTRAINT "SocialConnection_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SocialConnectionCredential" (
    "id" TEXT NOT NULL,
    "socialConnectionId" TEXT NOT NULL,
    "keyName" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialConnectionCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialConnectionCredential_socialConnectionId_keyName_key" ON "SocialConnectionCredential"("socialConnectionId", "keyName");

ALTER TABLE "SocialConnectionCredential"
  ADD CONSTRAINT "SocialConnectionCredential_socialConnectionId_fkey"
  FOREIGN KEY ("socialConnectionId") REFERENCES "SocialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
