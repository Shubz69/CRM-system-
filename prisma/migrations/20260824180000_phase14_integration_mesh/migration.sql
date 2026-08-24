-- Phase 14 — Integration mesh, sync, skills (additive)

CREATE TYPE "ConnectorCapabilityStatus" AS ENUM ('AVAILABLE', 'CONNECTED', 'AUTH_REQUIRED', 'SCOPE_REQUIRED', 'APPROVAL_REQUIRED', 'RESTRICTED', 'DEGRADED', 'UNSUPPORTED', 'DISABLED');
CREATE TYPE "ConnectorConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'REAUTH_REQUIRED', 'EXPIRED', 'REVOKED', 'ERROR', 'DISABLED');
CREATE TYPE "SyncRunKind" AS ENUM ('FULL_INITIAL', 'INCREMENTAL', 'WEBHOOK', 'MANUAL', 'RECONCILIATION');
CREATE TYPE "SyncRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');
CREATE TYPE "CircuitState" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');
CREATE TYPE "SkillDefinitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DEPRECATED', 'DISABLED');

CREATE TABLE "ConnectorCapabilityState" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "capability" TEXT NOT NULL,
    "status" "ConnectorCapabilityStatus" NOT NULL DEFAULT 'UNSUPPORTED',
    "provenance" TEXT NOT NULL,
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "detail" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConnectorCapabilityState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalObjectMapping" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "externalType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "internalType" TEXT NOT NULL,
    "internalId" TEXT NOT NULL,
    "externalUrl" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    "externalUpdatedAt" TIMESTAMP(3),
    "syncVersion" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalObjectMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncCursor" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "resource" TEXT NOT NULL,
    "cursorValue" TEXT NOT NULL,
    "cursorKind" TEXT NOT NULL DEFAULT 'opaque',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncCursor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "resource" TEXT NOT NULL,
    "kind" "SyncRunKind" NOT NULL DEFAULT 'INCREMENTAL',
    "status" "SyncRunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "cursorBefore" TEXT,
    "cursorAfter" TEXT,
    "errorSummary" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectorRateLimitState" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "operationClass" TEXT NOT NULL DEFAULT 'default',
    "remaining" INTEGER,
    "resetAt" TIMESTAMP(3),
    "backoffUntil" TIMESTAMP(3),
    "last429At" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectorRateLimitState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectorCircuitState" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "operationClass" TEXT NOT NULL DEFAULT 'default',
    "state" "CircuitState" NOT NULL DEFAULT 'CLOSED',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "halfOpenAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorSummary" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectorCircuitState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderHealthEvent" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "status" "ConnectorConnectionStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "summary" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderHealthEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillDefinition" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL DEFAULT '{}',
    "outputSchema" JSONB NOT NULL DEFAULT '{}',
    "requiredTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "optionalTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedAgents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "risk" TEXT NOT NULL DEFAULT 'read',
    "budgetHintCents" INTEGER,
    "evalSuiteKey" TEXT,
    "status" "SkillDefinitionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SkillDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillExecution" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "skillDefinitionId" TEXT NOT NULL,
    "skillKey" TEXT NOT NULL,
    "skillVersion" TEXT NOT NULL,
    "agentRunId" TEXT,
    "missionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "inputSummary" TEXT,
    "outputSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectorOperationLog" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "operation" TEXT NOT NULL,
    "toolName" TEXT,
    "success" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "costCents" INTEGER,
    "missionId" TEXT,
    "toolCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectorOperationLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConnectorCapabilityState_organisationId_providerKey_connectionRef_capability_key" ON "ConnectorCapabilityState"("organisationId", "providerKey", "connectionRef", "capability");
CREATE INDEX "ConnectorCapabilityState_organisationId_providerKey_status_idx" ON "ConnectorCapabilityState"("organisationId", "providerKey", "status");

CREATE UNIQUE INDEX "ExternalObjectMapping_organisationId_providerKey_externalType_externalId_key" ON "ExternalObjectMapping"("organisationId", "providerKey", "externalType", "externalId");
CREATE INDEX "ExternalObjectMapping_organisationId_internalType_internalId_idx" ON "ExternalObjectMapping"("organisationId", "internalType", "internalId");
CREATE INDEX "ExternalObjectMapping_organisationId_providerKey_lastSyncedAt_idx" ON "ExternalObjectMapping"("organisationId", "providerKey", "lastSyncedAt");

CREATE UNIQUE INDEX "SyncCursor_organisationId_providerKey_connectionRef_resource_key" ON "SyncCursor"("organisationId", "providerKey", "connectionRef", "resource");
CREATE INDEX "SyncCursor_organisationId_providerKey_idx" ON "SyncCursor"("organisationId", "providerKey");

CREATE INDEX "SyncRun_organisationId_providerKey_startedAt_idx" ON "SyncRun"("organisationId", "providerKey", "startedAt");
CREATE INDEX "SyncRun_organisationId_status_startedAt_idx" ON "SyncRun"("organisationId", "status", "startedAt");

CREATE UNIQUE INDEX "ConnectorRateLimitState_organisationId_providerKey_connectionRef_operationClass_key" ON "ConnectorRateLimitState"("organisationId", "providerKey", "connectionRef", "operationClass");
CREATE INDEX "ConnectorRateLimitState_organisationId_backoffUntil_idx" ON "ConnectorRateLimitState"("organisationId", "backoffUntil");

CREATE UNIQUE INDEX "ConnectorCircuitState_organisationId_providerKey_connectionRef_operationClass_key" ON "ConnectorCircuitState"("organisationId", "providerKey", "connectionRef", "operationClass");
CREATE INDEX "ConnectorCircuitState_organisationId_state_idx" ON "ConnectorCircuitState"("organisationId", "state");

CREATE INDEX "ProviderHealthEvent_organisationId_providerKey_observedAt_idx" ON "ProviderHealthEvent"("organisationId", "providerKey", "observedAt");

CREATE UNIQUE INDEX "SkillDefinition_organisationId_key_version_key" ON "SkillDefinition"("organisationId", "key", "version");
CREATE INDEX "SkillDefinition_key_status_idx" ON "SkillDefinition"("key", "status");

CREATE INDEX "SkillExecution_organisationId_skillKey_createdAt_idx" ON "SkillExecution"("organisationId", "skillKey", "createdAt");
CREATE INDEX "SkillExecution_organisationId_agentRunId_idx" ON "SkillExecution"("organisationId", "agentRunId");

CREATE INDEX "ConnectorOperationLog_organisationId_providerKey_createdAt_idx" ON "ConnectorOperationLog"("organisationId", "providerKey", "createdAt");
CREATE INDEX "ConnectorOperationLog_organisationId_success_createdAt_idx" ON "ConnectorOperationLog"("organisationId", "success", "createdAt");

ALTER TABLE "ConnectorCapabilityState" ADD CONSTRAINT "ConnectorCapabilityState_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalObjectMapping" ADD CONSTRAINT "ExternalObjectMapping_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncCursor" ADD CONSTRAINT "SyncCursor_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorRateLimitState" ADD CONSTRAINT "ConnectorRateLimitState_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorCircuitState" ADD CONSTRAINT "ConnectorCircuitState_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderHealthEvent" ADD CONSTRAINT "ProviderHealthEvent_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkillExecution" ADD CONSTRAINT "SkillExecution_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkillExecution" ADD CONSTRAINT "SkillExecution_skillDefinitionId_fkey" FOREIGN KEY ("skillDefinitionId") REFERENCES "SkillDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorOperationLog" ADD CONSTRAINT "ConnectorOperationLog_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
