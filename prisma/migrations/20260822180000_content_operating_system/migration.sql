-- Phase 6 Content Operating System.

CREATE TYPE "ContentOpportunityStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED', 'EXPIRED');
CREATE TYPE "ContentPieceStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'ARCHIVED');
CREATE TYPE "PublishingJobStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');

CREATE TABLE "ContentOpportunity" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "ContentOpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "whyEvidence" JSONB NOT NULL DEFAULT '{}',
    "researchJobId" TEXT,
    "trendClusterId" TEXT,
    "agentRunId" TEXT,
    "score" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ContentOpportunity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentOpportunity_organisationId_status_createdAt_idx" ON "ContentOpportunity"("organisationId", "status", "createdAt");
CREATE INDEX "ContentOpportunity_organisationId_researchJobId_idx" ON "ContentOpportunity"("organisationId", "researchJobId");
CREATE INDEX "ContentOpportunity_organisationId_trendClusterId_idx" ON "ContentOpportunity"("organisationId", "trendClusterId");

ALTER TABLE "ContentOpportunity"
  ADD CONSTRAINT "ContentOpportunity_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContentIdea" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "title" TEXT NOT NULL,
    "angle" TEXT,
    "hook" TEXT,
    "formatHint" TEXT,
    "whyEvidence" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentIdea_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentIdea_organisationId_createdAt_idx" ON "ContentIdea"("organisationId", "createdAt");
CREATE INDEX "ContentIdea_organisationId_opportunityId_idx" ON "ContentIdea"("organisationId", "opportunityId");

ALTER TABLE "ContentIdea"
  ADD CONSTRAINT "ContentIdea_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentIdea"
  ADD CONSTRAINT "ContentIdea_opportunityId_fkey"
  FOREIGN KEY ("opportunityId") REFERENCES "ContentOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CreativeBrief" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "objective" TEXT,
    "audience" TEXT,
    "keyMessage" TEXT,
    "cta" TEXT,
    "constraints" TEXT,
    "whyEvidence" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeBrief_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreativeBrief_organisationId_ideaId_idx" ON "CreativeBrief"("organisationId", "ideaId");

ALTER TABLE "CreativeBrief"
  ADD CONSTRAINT "CreativeBrief_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreativeBrief"
  ADD CONSTRAINT "CreativeBrief_ideaId_fkey"
  FOREIGN KEY ("ideaId") REFERENCES "ContentIdea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContentPiece" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "briefId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContentPieceStatus" NOT NULL DEFAULT 'DRAFT',
    "platform" TEXT,
    "whyEvidence" JSONB NOT NULL DEFAULT '{}',
    "assetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPiece_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentPiece_organisationId_status_createdAt_idx" ON "ContentPiece"("organisationId", "status", "createdAt");
CREATE INDEX "ContentPiece_organisationId_briefId_idx" ON "ContentPiece"("organisationId", "briefId");

ALTER TABLE "ContentPiece"
  ADD CONSTRAINT "ContentPiece_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentPiece"
  ADD CONSTRAINT "ContentPiece_briefId_fkey"
  FOREIGN KEY ("briefId") REFERENCES "CreativeBrief"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ContentVersion" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "pieceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentVersion_pieceId_version_key" ON "ContentVersion"("pieceId", "version");
CREATE INDEX "ContentVersion_organisationId_pieceId_idx" ON "ContentVersion"("organisationId", "pieceId");

ALTER TABLE "ContentVersion"
  ADD CONSTRAINT "ContentVersion_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentVersion"
  ADD CONSTRAINT "ContentVersion_pieceId_fkey"
  FOREIGN KEY ("pieceId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContentVariant" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "pieceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "label" TEXT,
    "body" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentVariant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentVariant_organisationId_pieceId_platform_idx" ON "ContentVariant"("organisationId", "pieceId", "platform");

ALTER TABLE "ContentVariant"
  ADD CONSTRAINT "ContentVariant_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentVariant"
  ADD CONSTRAINT "ContentVariant_pieceId_fkey"
  FOREIGN KEY ("pieceId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContentApproval" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "pieceId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ContentApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentApproval_organisationId_pieceId_createdAt_idx" ON "ContentApproval"("organisationId", "pieceId", "createdAt");
CREATE INDEX "ContentApproval_organisationId_decision_idx" ON "ContentApproval"("organisationId", "decision");

ALTER TABLE "ContentApproval"
  ADD CONSTRAINT "ContentApproval_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentApproval"
  ADD CONSTRAINT "ContentApproval_pieceId_fkey"
  FOREIGN KEY ("pieceId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PublishingJob" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "pieceId" TEXT NOT NULL,
    "variantId" TEXT,
    "platform" TEXT NOT NULL,
    "status" "PublishingJobStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "socialConnectionId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "externalPostId" TEXT,
    "externalUrl" TEXT,
    "error" TEXT,
    "policySnapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PublishingJob_organisationId_status_createdAt_idx" ON "PublishingJob"("organisationId", "status", "createdAt");
CREATE INDEX "PublishingJob_organisationId_pieceId_idx" ON "PublishingJob"("organisationId", "pieceId");
CREATE INDEX "PublishingJob_organisationId_platform_status_idx" ON "PublishingJob"("organisationId", "platform", "status");

ALTER TABLE "PublishingJob"
  ADD CONSTRAINT "PublishingJob_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PublishingJob"
  ADD CONSTRAINT "PublishingJob_pieceId_fkey"
  FOREIGN KEY ("pieceId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PostPerformance" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "pieceId" TEXT,
    "publishingJobId" TEXT,
    "socialContentId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "clicks" INTEGER,
    "leadsAttributed" INTEGER,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostPerformance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PostPerformance_organisationId_pieceId_capturedAt_idx" ON "PostPerformance"("organisationId", "pieceId", "capturedAt");
CREATE INDEX "PostPerformance_organisationId_publishingJobId_idx" ON "PostPerformance"("organisationId", "publishingJobId");
CREATE INDEX "PostPerformance_organisationId_capturedAt_idx" ON "PostPerformance"("organisationId", "capturedAt");

ALTER TABLE "PostPerformance"
  ADD CONSTRAINT "PostPerformance_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostPerformance"
  ADD CONSTRAINT "PostPerformance_pieceId_fkey"
  FOREIGN KEY ("pieceId") REFERENCES "ContentPiece"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PostPerformance"
  ADD CONSTRAINT "PostPerformance_publishingJobId_fkey"
  FOREIGN KEY ("publishingJobId") REFERENCES "PublishingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
