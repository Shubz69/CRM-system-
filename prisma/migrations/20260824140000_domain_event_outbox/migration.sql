-- Phase 12B: Transactional domain event outbox

CREATE TYPE "DomainEventStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'RETRY',
  'DEAD_LETTER',
  'CANCELLED'
);

CREATE TYPE "DomainEventConsumptionStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'SKIPPED'
);

CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" INTEGER NOT NULL DEFAULT 1,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "DomainEventStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "lockedAt" TIMESTAMP(3),
    "lockOwner" TEXT,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "errorClass" TEXT,
    "firstFailedAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "correlationId" TEXT,
    "causationId" TEXT,
    "actorType" TEXT,
    "actorId" TEXT,
    "dedupeKey" TEXT,
    "aggregateSequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DomainEventConsumption" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "status" "DomainEventConsumptionStatus" NOT NULL DEFAULT 'PENDING',
    "processedAt" TIMESTAMP(3),
    "resultReference" TEXT,
    "lastError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainEventConsumption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DomainEvent_organisationId_dedupeKey_key" ON "DomainEvent"("organisationId", "dedupeKey");
CREATE INDEX "DomainEvent_organisationId_status_availableAt_idx" ON "DomainEvent"("organisationId", "status", "availableAt");
CREATE INDEX "DomainEvent_organisationId_aggregateType_aggregateId_aggregateSequence_idx" ON "DomainEvent"("organisationId", "aggregateType", "aggregateId", "aggregateSequence");
CREATE INDEX "DomainEvent_organisationId_correlationId_idx" ON "DomainEvent"("organisationId", "correlationId");
CREATE INDEX "DomainEvent_status_availableAt_idx" ON "DomainEvent"("status", "availableAt");
CREATE INDEX "DomainEvent_eventType_createdAt_idx" ON "DomainEvent"("eventType", "createdAt");

CREATE UNIQUE INDEX "DomainEventConsumption_eventId_consumer_key" ON "DomainEventConsumption"("eventId", "consumer");
CREATE INDEX "DomainEventConsumption_organisationId_consumer_status_idx" ON "DomainEventConsumption"("organisationId", "consumer", "status");
CREATE INDEX "DomainEventConsumption_organisationId_createdAt_idx" ON "DomainEventConsumption"("organisationId", "createdAt");

ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DomainEventConsumption" ADD CONSTRAINT "DomainEventConsumption_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DomainEventConsumption" ADD CONSTRAINT "DomainEventConsumption_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "DomainEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
