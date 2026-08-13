-- Research / social listening domain (org-scoped throughout).

CREATE TYPE "ResearchJobKind" AS ENUM ('RESEARCH', 'SOCIAL_LISTENING');
CREATE TYPE "ResearchJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

CREATE TABLE "ResearchJob" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "kind" "ResearchJobKind" NOT NULL,
    "topic" TEXT NOT NULL,
    "status" "ResearchJobStatus" NOT NULL DEFAULT 'PENDING',
    "queries" JSONB NOT NULL DEFAULT '[]',
    "brief" JSONB,
    "contradictions" JSONB,
    "gaps" JSONB,
    "criticReport" JSONB,
    "totalCostCents" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "userFacingError" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchJob_organisationId_createdAt_idx" ON "ResearchJob"("organisationId", "createdAt");
CREATE INDEX "ResearchJob_organisationId_status_idx" ON "ResearchJob"("organisationId", "status");
CREATE INDEX "ResearchJob_organisationId_kind_createdAt_idx" ON "ResearchJob"("organisationId", "kind", "createdAt");
CREATE INDEX "ResearchJob_agentRunId_idx" ON "ResearchJob"("agentRunId");

ALTER TABLE "ResearchJob"
  ADD CONSTRAINT "ResearchJob_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ResearchSource" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "researchJobId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "platform" TEXT NOT NULL,
    "author" TEXT,
    "publishedAt" TIMESTAMP(3),
    "content" TEXT,
    "engagement" JSONB,
    "rawMetadata" JSONB NOT NULL DEFAULT '{}',
    "queryUsed" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchSource_researchJobId_url_key" ON "ResearchSource"("researchJobId", "url");
CREATE INDEX "ResearchSource_organisationId_researchJobId_idx" ON "ResearchSource"("organisationId", "researchJobId");
CREATE INDEX "ResearchSource_organisationId_platform_createdAt_idx" ON "ResearchSource"("organisationId", "platform", "createdAt");

ALTER TABLE "ResearchSource"
  ADD CONSTRAINT "ResearchSource_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchSource"
  ADD CONSTRAINT "ResearchSource_researchJobId_fkey"
  FOREIGN KEY ("researchJobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ResearchFinding" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "researchJobId" TEXT NOT NULL,
    "researchSourceId" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "evidenceExcerpt" TEXT,
    "confidence" DOUBLE PRECISION,
    "verifiedByCritic" BOOLEAN NOT NULL DEFAULT false,
    "flaggedUnsupported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchFinding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchFinding_organisationId_researchJobId_idx" ON "ResearchFinding"("organisationId", "researchJobId");
CREATE INDEX "ResearchFinding_organisationId_researchSourceId_idx" ON "ResearchFinding"("organisationId", "researchSourceId");

ALTER TABLE "ResearchFinding"
  ADD CONSTRAINT "ResearchFinding_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchFinding"
  ADD CONSTRAINT "ResearchFinding_researchJobId_fkey"
  FOREIGN KEY ("researchJobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchFinding"
  ADD CONSTRAINT "ResearchFinding_researchSourceId_fkey"
  FOREIGN KEY ("researchSourceId") REFERENCES "ResearchSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "researchJobId" TEXT NOT NULL,
    "researchSourceId" TEXT,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "author" TEXT,
    "publishedAt" TIMESTAMP(3),
    "content" TEXT,
    "engagement" JSONB,
    "extractedThemes" JSONB NOT NULL DEFAULT '[]',
    "extractedHooks" JSONB NOT NULL DEFAULT '[]',
    "extractedFormats" JSONB NOT NULL DEFAULT '[]',
    "extractedQuestions" JSONB NOT NULL DEFAULT '[]',
    "extractedComplaints" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialPost_researchJobId_url_key" ON "SocialPost"("researchJobId", "url");
CREATE INDEX "SocialPost_organisationId_researchJobId_idx" ON "SocialPost"("organisationId", "researchJobId");
CREATE INDEX "SocialPost_organisationId_platform_createdAt_idx" ON "SocialPost"("organisationId", "platform", "createdAt");

ALTER TABLE "SocialPost"
  ADD CONSTRAINT "SocialPost_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPost"
  ADD CONSTRAINT "SocialPost_researchJobId_fkey"
  FOREIGN KEY ("researchJobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPost"
  ADD CONSTRAINT "SocialPost_researchSourceId_fkey"
  FOREIGN KEY ("researchSourceId") REFERENCES "ResearchSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TrendSignal" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "researchJobId" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "frequency" INTEGER NOT NULL DEFAULT 1,
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendSignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrendSignal_organisationId_researchJobId_idx" ON "TrendSignal"("organisationId", "researchJobId");
CREATE INDEX "TrendSignal_organisationId_signalType_frequency_idx" ON "TrendSignal"("organisationId", "signalType", "frequency");

ALTER TABLE "TrendSignal"
  ADD CONSTRAINT "TrendSignal_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrendSignal"
  ADD CONSTRAINT "TrendSignal_researchJobId_fkey"
  FOREIGN KEY ("researchJobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
