-- Phase 12: Durable Mission runtime (Postgres source of truth)

CREATE TYPE "MissionStatus" AS ENUM (
  'QUEUED',
  'PLANNING',
  'RUNNING',
  'WAITING',
  'WAITING_APPROVAL',
  'BLOCKED',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "MissionTaskStatus" AS ENUM (
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING',
  'WAITING_APPROVAL',
  'BLOCKED',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'SKIPPED'
);

CREATE TYPE "MissionErrorClass" AS ENUM (
  'NONE',
  'TRANSIENT',
  'RATE_LIMIT',
  'TIMEOUT',
  'TOOL_FAILED',
  'PROVIDER_OUTAGE',
  'OAUTH_EXPIRED',
  'BUDGET',
  'PERMISSION',
  'VALIDATION',
  'DEPENDENCY',
  'CANCELLED',
  'UNKNOWN'
);

CREATE TABLE "AgentMission" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "goalId" TEXT,
    "createdByUserId" TEXT,
    "title" TEXT NOT NULL,
    "objectiveSummary" TEXT NOT NULL,
    "status" "MissionStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "planSummary" TEXT,
    "budgetCents" INTEGER,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "deadlineAt" TIMESTAMP(3),
    "resumeCursor" JSONB,
    "lastErrorClass" "MissionErrorClass" NOT NULL DEFAULT 'NONE',
    "lastErrorMessage" TEXT,
    "decisionSummary" TEXT,
    "confidence" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MissionTask" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "MissionTaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "deadlineAt" TIMESTAMP(3),
    "budgetCents" INTEGER,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "assignedAgent" TEXT,
    "assignedAgentVersion" TEXT,
    "checkpointRef" TEXT,
    "errorClass" "MissionErrorClass" NOT NULL DEFAULT 'NONE',
    "lastError" TEXT,
    "resultSummary" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MissionTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MissionTaskDependency" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "dependsOnTaskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionTaskDependency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MissionCheckpoint" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "taskId" TEXT,
    "payload" JSONB NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MissionArtifact" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "taskId" TEXT,
    "kind" TEXT NOT NULL,
    "uri" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionArtifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MissionOutcome" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "evaluationNotes" TEXT,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionOutcome_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgentRun" ADD COLUMN "missionId" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "missionTaskId" TEXT;

CREATE INDEX "AgentMission_organisationId_status_createdAt_idx" ON "AgentMission"("organisationId", "status", "createdAt");
CREATE INDEX "AgentMission_organisationId_deadlineAt_idx" ON "AgentMission"("organisationId", "deadlineAt");
CREATE INDEX "AgentMission_goalId_idx" ON "AgentMission"("goalId");

CREATE UNIQUE INDEX "MissionTask_missionId_idempotencyKey_key" ON "MissionTask"("missionId", "idempotencyKey");
CREATE INDEX "MissionTask_organisationId_missionId_status_idx" ON "MissionTask"("organisationId", "missionId", "status");
CREATE INDEX "MissionTask_organisationId_status_priority_idx" ON "MissionTask"("organisationId", "status", "priority");

CREATE UNIQUE INDEX "MissionTaskDependency_taskId_dependsOnTaskId_key" ON "MissionTaskDependency"("taskId", "dependsOnTaskId");
CREATE INDEX "MissionTaskDependency_missionId_idx" ON "MissionTaskDependency"("missionId");
CREATE INDEX "MissionTaskDependency_organisationId_missionId_idx" ON "MissionTaskDependency"("organisationId", "missionId");

CREATE INDEX "MissionCheckpoint_organisationId_missionId_createdAt_idx" ON "MissionCheckpoint"("organisationId", "missionId", "createdAt");
CREATE INDEX "MissionArtifact_organisationId_missionId_idx" ON "MissionArtifact"("organisationId", "missionId");
CREATE INDEX "MissionOutcome_organisationId_missionId_idx" ON "MissionOutcome"("organisationId", "missionId");

CREATE INDEX "AgentRun_missionId_idx" ON "AgentRun"("missionId");
CREATE INDEX "AgentRun_missionTaskId_idx" ON "AgentRun"("missionTaskId");

ALTER TABLE "AgentMission" ADD CONSTRAINT "AgentMission_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MissionTask" ADD CONSTRAINT "MissionTask_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MissionTask" ADD CONSTRAINT "MissionTask_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "AgentMission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MissionTaskDependency" ADD CONSTRAINT "MissionTaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "MissionTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MissionTaskDependency" ADD CONSTRAINT "MissionTaskDependency_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "MissionTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MissionCheckpoint" ADD CONSTRAINT "MissionCheckpoint_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MissionCheckpoint" ADD CONSTRAINT "MissionCheckpoint_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "AgentMission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MissionArtifact" ADD CONSTRAINT "MissionArtifact_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MissionArtifact" ADD CONSTRAINT "MissionArtifact_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "AgentMission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MissionOutcome" ADD CONSTRAINT "MissionOutcome_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MissionOutcome" ADD CONSTRAINT "MissionOutcome_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "AgentMission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "AgentMission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_missionTaskId_fkey" FOREIGN KEY ("missionTaskId") REFERENCES "MissionTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
