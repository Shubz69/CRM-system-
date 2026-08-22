-- Research Evidence Fabric: snapshots, claim kinds, freshness, ungrounded flags.

CREATE TYPE "ResearchClaimKind" AS ENUM ('OFFICIAL', 'OBSERVATION', 'INFERENCE', 'SECONDARY', 'UNKNOWN');

ALTER TABLE "ResearchSource"
  ADD COLUMN "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "freshnessScore" DOUBLE PRECISION;

CREATE INDEX "ResearchSource_organisationId_contentHash_idx"
  ON "ResearchSource"("organisationId", "contentHash");

CREATE TABLE "ResearchSourceSnapshot" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "researchJobId" TEXT NOT NULL,
    "researchSourceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "platform" TEXT NOT NULL,
    "author" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "content" TEXT,
    "contentHash" TEXT,
    "engagement" JSONB,
    "rawMetadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchSourceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchSourceSnapshot_researchSourceId_key"
  ON "ResearchSourceSnapshot"("researchSourceId");
CREATE INDEX "ResearchSourceSnapshot_organisationId_researchJobId_idx"
  ON "ResearchSourceSnapshot"("organisationId", "researchJobId");
CREATE INDEX "ResearchSourceSnapshot_organisationId_contentHash_idx"
  ON "ResearchSourceSnapshot"("organisationId", "contentHash");
CREATE INDEX "ResearchSourceSnapshot_organisationId_retrievedAt_idx"
  ON "ResearchSourceSnapshot"("organisationId", "retrievedAt");

ALTER TABLE "ResearchSourceSnapshot"
  ADD CONSTRAINT "ResearchSourceSnapshot_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResearchSourceSnapshot"
  ADD CONSTRAINT "ResearchSourceSnapshot_researchJobId_fkey"
  FOREIGN KEY ("researchJobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResearchSourceSnapshot"
  ADD CONSTRAINT "ResearchSourceSnapshot_researchSourceId_fkey"
  FOREIGN KEY ("researchSourceId") REFERENCES "ResearchSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResearchFinding"
  ADD COLUMN "claimKind" "ResearchClaimKind" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "freshnessScore" DOUBLE PRECISION,
  ADD COLUMN "flaggedUngrounded" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ResearchFinding_organisationId_claimKind_idx"
  ON "ResearchFinding"("organisationId", "claimKind");
