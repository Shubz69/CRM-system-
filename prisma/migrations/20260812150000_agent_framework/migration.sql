-- Agent framework persistence (Prompt 2B). Forward-only migration.
-- organisationId REQUIRED on AgentRun, AgentStep, ToolCall.

CREATE TYPE "AgentRunStatus" AS ENUM (
  'PENDING',
  'PLANNING',
  'AWAITING_CLARIFICATION',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "AgentStepStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED'
);

CREATE TABLE "OrganisationAgentLimits" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "maxSteps" INTEGER NOT NULL DEFAULT 8,
    "maxWallClockSeconds" INTEGER NOT NULL DEFAULT 600,
    "maxSpendCentsPerRun" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganisationAgentLimits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganisationAgentLimits_organisationId_key" ON "OrganisationAgentLimits"("organisationId");

ALTER TABLE "OrganisationAgentLimits"
  ADD CONSTRAINT "OrganisationAgentLimits_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'user',
    "request" TEXT NOT NULL,
    "plan" JSONB,
    "plainEnglishPlan" TEXT,
    "clarificationQuestion" TEXT,
    "clarificationOptions" JSONB,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "totalCostCents" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "userFacingError" TEXT,
    "partialResults" JSONB,
    "finalOutput" JSONB,
    "maxSteps" INTEGER NOT NULL DEFAULT 8,
    "maxWallClockSeconds" INTEGER NOT NULL DEFAULT 600,
    "maxSpendCents" INTEGER,
    "bullJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRun_organisationId_createdAt_idx" ON "AgentRun"("organisationId", "createdAt");
CREATE INDEX "AgentRun_organisationId_status_idx" ON "AgentRun"("organisationId", "status");
CREATE INDEX "AgentRun_bullJobId_idx" ON "AgentRun"("bullJobId");

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AgentStep" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "agentName" TEXT NOT NULL,
    "userFacingLabel" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "status" "AgentStepStatus" NOT NULL DEFAULT 'PENDING',
    "userFacingStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentStep_organisationId_agentRunId_idx" ON "AgentStep"("organisationId", "agentRunId");
CREATE INDEX "AgentStep_agentRunId_position_idx" ON "AgentStep"("agentRunId", "position");

ALTER TABLE "AgentStep"
  ADD CONSTRAINT "AgentStep_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentStep"
  ADD CONSTRAINT "AgentStep_agentRunId_fkey"
  FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "agentStepId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ToolCall_organisationId_agentStepId_idx" ON "ToolCall"("organisationId", "agentStepId");
CREATE INDEX "ToolCall_agentStepId_createdAt_idx" ON "ToolCall"("agentStepId", "createdAt");

ALTER TABLE "ToolCall"
  ADD CONSTRAINT "ToolCall_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ToolCall"
  ADD CONSTRAINT "ToolCall_agentStepId_fkey"
  FOREIGN KEY ("agentStepId") REFERENCES "AgentStep"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
