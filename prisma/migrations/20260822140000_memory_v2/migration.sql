-- Memory V2: episodic, entity facts, performance outcomes, organisation preferences.

CREATE TYPE "MemoryEntityFactStatus" AS ENUM ('CANDIDATE', 'APPROVED', 'REJECTED');

CREATE TABLE "MemoryEpisode" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'ask',
    "summary" TEXT NOT NULL,
    "requestPreview" TEXT,
    "outcomeStatus" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryEpisode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MemoryEpisode_organisationId_createdAt_idx" ON "MemoryEpisode"("organisationId", "createdAt");
CREATE INDEX "MemoryEpisode_organisationId_expiresAt_idx" ON "MemoryEpisode"("organisationId", "expiresAt");
CREATE INDEX "MemoryEpisode_organisationId_kind_createdAt_idx" ON "MemoryEpisode"("organisationId", "kind", "createdAt");
CREATE INDEX "MemoryEpisode_agentRunId_idx" ON "MemoryEpisode"("agentRunId");

ALTER TABLE "MemoryEpisode"
  ADD CONSTRAINT "MemoryEpisode_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryEpisode"
  ADD CONSTRAINT "MemoryEpisode_agentRunId_fkey"
  FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MemoryEntityFact" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "factValue" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "provenance" JSONB NOT NULL,
    "status" "MemoryEntityFactStatus" NOT NULL DEFAULT 'CANDIDATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryEntityFact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryEntityFact_organisationId_entityType_entityKey_factKey_key"
  ON "MemoryEntityFact"("organisationId", "entityType", "entityKey", "factKey");
CREATE INDEX "MemoryEntityFact_organisationId_entityType_entityKey_idx"
  ON "MemoryEntityFact"("organisationId", "entityType", "entityKey");
CREATE INDEX "MemoryEntityFact_organisationId_status_updatedAt_idx"
  ON "MemoryEntityFact"("organisationId", "status", "updatedAt");

ALTER TABLE "MemoryEntityFact"
  ADD CONSTRAINT "MemoryEntityFact_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MemoryPerformanceOutcome" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceRef" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryPerformanceOutcome_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MemoryPerformanceOutcome_organisationId_kind_measuredAt_idx"
  ON "MemoryPerformanceOutcome"("organisationId", "kind", "measuredAt");
CREATE INDEX "MemoryPerformanceOutcome_organisationId_subjectKey_measuredAt_idx"
  ON "MemoryPerformanceOutcome"("organisationId", "subjectKey", "measuredAt");
CREATE INDEX "MemoryPerformanceOutcome_organisationId_sourceRef_idx"
  ON "MemoryPerformanceOutcome"("organisationId", "sourceRef");

ALTER TABLE "MemoryPerformanceOutcome"
  ADD CONSTRAINT "MemoryPerformanceOutcome_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OrganisationPreference" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganisationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganisationPreference_organisationId_key_key"
  ON "OrganisationPreference"("organisationId", "key");
CREATE INDEX "OrganisationPreference_organisationId_idx"
  ON "OrganisationPreference"("organisationId");

ALTER TABLE "OrganisationPreference"
  ADD CONSTRAINT "OrganisationPreference_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
