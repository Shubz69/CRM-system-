-- Agent artifact retention: per-org windows + tier markers.
-- finalOutput is never pruned; ToolCall payloads clear after the retention window.

CREATE TYPE "AgentDetailRetention" AS ENUM ('FULL', 'COMPACT', 'SKELETON');
CREATE TYPE "PartialResultsRetention" AS ENUM ('FULL', 'SUMMARY');

CREATE TABLE "OrganisationAgentRetention" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "toolCallPayloadDays" INTEGER NOT NULL DEFAULT 14,
    "stepFullDetailDays" INTEGER NOT NULL DEFAULT 30,
    "stepSkeletonAfterDays" INTEGER NOT NULL DEFAULT 180,
    "partialResultsFullDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganisationAgentRetention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganisationAgentRetention_organisationId_key" ON "OrganisationAgentRetention"("organisationId");

ALTER TABLE "OrganisationAgentRetention"
  ADD CONSTRAINT "OrganisationAgentRetention_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun"
  ADD COLUMN "partialResultsRetention" "PartialResultsRetention" NOT NULL DEFAULT 'FULL';

CREATE INDEX "AgentRun_organisationId_partialResultsRetention_createdAt_idx"
  ON "AgentRun"("organisationId", "partialResultsRetention", "createdAt");

ALTER TABLE "AgentStep"
  ADD COLUMN "detailRetention" "AgentDetailRetention" NOT NULL DEFAULT 'FULL';

CREATE INDEX "AgentStep_organisationId_detailRetention_createdAt_idx"
  ON "AgentStep"("organisationId", "detailRetention", "createdAt");

ALTER TABLE "ToolCall"
  ADD COLUMN "payloadClearedAt" TIMESTAMP(3);

CREATE INDEX "ToolCall_organisationId_payloadClearedAt_createdAt_idx"
  ON "ToolCall"("organisationId", "payloadClearedAt", "createdAt");
