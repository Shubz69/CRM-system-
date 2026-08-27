-- Conversation Revenue Engine (additive)

-- Conversation extensions
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "activityVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "priorityClass" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "closedReason" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "handoffPacket" JSONB;

-- Message extensions
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "failureCode" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "providerError" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "inReplyToMessageId" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "agentVersion" TEXT;

DO $$ BEGIN
  CREATE TYPE "MessagingExternalOutcome" AS ENUM ('NOT_STARTED', 'PREPARED', 'DISPATCHING', 'CONFIRMED', 'FAILED', 'RECONCILIATION_REQUIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SuppressionReason" AS ENUM ('OPT_OUT', 'COMPLAINT', 'HARD_BOUNCE', 'INVALID_CONTACT', 'MANUAL_BLOCK', 'LEGAL_RESTRICTION', 'PROVIDER_RESTRICTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ContactSuppression" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "channel" TEXT,
  "provider" TEXT,
  "reason" "SuppressionReason" NOT NULL,
  "source" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContactSuppression_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConversationUnderstanding" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "intent" TEXT,
  "objectionCategory" TEXT,
  "buyingStage" TEXT,
  "urgency" TEXT,
  "qualificationHint" TEXT,
  "customerNeed" TEXT,
  "productInterest" TEXT,
  "budgetSignal" TEXT,
  "timelineSignal" TEXT,
  "authoritySignal" TEXT,
  "competitorMention" TEXT,
  "meetingIntent" BOOLEAN NOT NULL DEFAULT false,
  "noResponseRisk" TEXT,
  "disengagementRisk" TEXT,
  "confidenceBand" TEXT NOT NULL DEFAULT 'LOW',
  "evidenceMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "extractorVersion" TEXT NOT NULL DEFAULT 'understand-v1',
  "factors" JSONB NOT NULL DEFAULT '{}',
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationUnderstanding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OutboundDispatch" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "messageId" TEXT,
  "provider" TEXT NOT NULL,
  "connectionRef" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "externalOutcome" "MessagingExternalOutcome" NOT NULL DEFAULT 'NOT_STARTED',
  "externalMessageId" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "holder" TEXT NOT NULL,
  "expectedLastMessageId" TEXT,
  "expectedActivityVersion" INTEGER,
  "failureCode" TEXT,
  "providerError" TEXT,
  "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "staleCancelled" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboundDispatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConversationSendLease" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "holder" TEXT NOT NULL,
  "expectedLastMessageId" TEXT,
  "expectedActivityVersion" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationSendLease_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Conversation_organisationId_priorityClass_idx" ON "Conversation"("organisationId", "priorityClass");
CREATE INDEX IF NOT EXISTS "Message_organisationId_conversationId_sentAt_idx" ON "Message"("organisationId", "conversationId", "sentAt");

CREATE INDEX IF NOT EXISTS "ContactSuppression_organisationId_contactId_idx" ON "ContactSuppression"("organisationId", "contactId");
CREATE INDEX IF NOT EXISTS "ContactSuppression_organisationId_reason_idx" ON "ContactSuppression"("organisationId", "reason");
CREATE INDEX IF NOT EXISTS "ContactSuppression_contactId_channel_idx" ON "ContactSuppression"("contactId", "channel");

CREATE INDEX IF NOT EXISTS "ConversationUnderstanding_organisationId_conversationId_observedAt_idx" ON "ConversationUnderstanding"("organisationId", "conversationId", "observedAt");
CREATE INDEX IF NOT EXISTS "ConversationUnderstanding_conversationId_version_idx" ON "ConversationUnderstanding"("conversationId", "version");

CREATE UNIQUE INDEX IF NOT EXISTS "OutboundDispatch_organisationId_idempotencyKey_key" ON "OutboundDispatch"("organisationId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "OutboundDispatch_organisationId_externalOutcome_createdAt_idx" ON "OutboundDispatch"("organisationId", "externalOutcome", "createdAt");
CREATE INDEX IF NOT EXISTS "OutboundDispatch_conversationId_createdAt_idx" ON "OutboundDispatch"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "OutboundDispatch_messageId_idx" ON "OutboundDispatch"("messageId");

CREATE UNIQUE INDEX IF NOT EXISTS "ConversationSendLease_conversationId_key" ON "ConversationSendLease"("conversationId");
CREATE INDEX IF NOT EXISTS "ConversationSendLease_organisationId_expiresAt_idx" ON "ConversationSendLease"("organisationId", "expiresAt");

ALTER TABLE "ContactSuppression" DROP CONSTRAINT IF EXISTS "ContactSuppression_organisationId_fkey";
ALTER TABLE "ContactSuppression" ADD CONSTRAINT "ContactSuppression_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactSuppression" DROP CONSTRAINT IF EXISTS "ContactSuppression_contactId_fkey";
ALTER TABLE "ContactSuppression" ADD CONSTRAINT "ContactSuppression_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationUnderstanding" DROP CONSTRAINT IF EXISTS "ConversationUnderstanding_organisationId_fkey";
ALTER TABLE "ConversationUnderstanding" ADD CONSTRAINT "ConversationUnderstanding_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationUnderstanding" DROP CONSTRAINT IF EXISTS "ConversationUnderstanding_conversationId_fkey";
ALTER TABLE "ConversationUnderstanding" ADD CONSTRAINT "ConversationUnderstanding_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutboundDispatch" DROP CONSTRAINT IF EXISTS "OutboundDispatch_organisationId_fkey";
ALTER TABLE "OutboundDispatch" ADD CONSTRAINT "OutboundDispatch_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboundDispatch" DROP CONSTRAINT IF EXISTS "OutboundDispatch_conversationId_fkey";
ALTER TABLE "OutboundDispatch" ADD CONSTRAINT "OutboundDispatch_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboundDispatch" DROP CONSTRAINT IF EXISTS "OutboundDispatch_messageId_fkey";
ALTER TABLE "OutboundDispatch" ADD CONSTRAINT "OutboundDispatch_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConversationSendLease" DROP CONSTRAINT IF EXISTS "ConversationSendLease_organisationId_fkey";
ALTER TABLE "ConversationSendLease" ADD CONSTRAINT "ConversationSendLease_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationSendLease" DROP CONSTRAINT IF EXISTS "ConversationSendLease_conversationId_fkey";
ALTER TABLE "ConversationSendLease" ADD CONSTRAINT "ConversationSendLease_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
