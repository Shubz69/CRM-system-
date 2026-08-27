-- Phase 20 — Differentiation intelligence layer (additive)

-- AlterTable AgentMission
ALTER TABLE "AgentMission" ADD COLUMN IF NOT EXISTS "decisionId" TEXT;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ComputeExecutionMode" AS ENUM ('DETERMINISTIC', 'CACHE', 'ECONOMY', 'STANDARD', 'ADVANCED', 'DEEP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ToolTrustStatus" AS ENUM ('TRUSTED', 'LIMITED', 'REVIEW_REQUIRED', 'QUARANTINED', 'BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DecisionStatus" AS ENUM ('DRAFT', 'COMPARING', 'PENDING_APPROVAL', 'DECIDED', 'EXECUTING', 'COMPLETED', 'CANCELLED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreativePatternMaturity" AS ENUM ('INSUFFICIENT_DATA', 'EMERGING_PATTERN', 'SUPPORTED_PATTERN', 'STRONG_PATTERN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CounterfactualMaturity" AS ENUM ('EVIDENCE_COMPARISON', 'HISTORICAL_SIMILARITY', 'CALIBRATED_ESTIMATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EvidenceDebtStatus" AS ENUM ('OPEN', 'RECOMMENDED', 'SCHEDULED', 'RESOLVED', 'DEPRECATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AutomationOpportunityStatus" AS ENUM ('DETECTED', 'REVIEWING', 'APPROVED', 'REJECTED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ComputeDecision" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "taskType" TEXT NOT NULL,
  "executionMode" "ComputeExecutionMode" NOT NULL,
  "selectedModel" TEXT,
  "selectedProvider" TEXT,
  "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "escalationReason" TEXT,
  "estimatedCostCents" INTEGER,
  "actualCostCents" INTEGER,
  "qualityBudget" TEXT,
  "cacheHit" BOOLEAN NOT NULL DEFAULT false,
  "shadowLegacyTier" TEXT,
  "shadowLegacyModel" TEXT,
  "shadowMatch" BOOLEAN,
  "aiExecutionId" TEXT,
  "errorSummary" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComputeDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ComputeAggregate" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "mode" "ComputeExecutionMode" NOT NULL,
  "taskType" TEXT NOT NULL DEFAULT '*',
  "count" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComputeAggregate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ToolTrustRecord" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL DEFAULT 'global',
  "toolKey" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'builtin',
  "origin" TEXT NOT NULL DEFAULT 'first_party',
  "version" TEXT NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "dataClasses" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "sideEffects" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "externalDestinations" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "riskLevel" TEXT NOT NULL DEFAULT 'read',
  "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
  "allowedAgentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "ToolTrustStatus" NOT NULL DEFAULT 'TRUSTED',
  "lastInspectionAt" TIMESTAMP(3),
  "verificationNote" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ToolTrustRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StateDefinition" (
  "id" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "valueDomain" JSONB NOT NULL DEFAULT '{}',
  "calculatorKey" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StateDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StateSnapshot" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "stateDefinitionId" TEXT,
  "value" TEXT NOT NULL,
  "numericValue" DOUBLE PRECISION,
  "reasonCode" TEXT,
  "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StateSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StateTransition" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "fromValue" TEXT,
  "toValue" TEXT NOT NULL,
  "reasonCode" TEXT,
  "fromSnapshotId" TEXT,
  "toSnapshotId" TEXT,
  "triggeredByEventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StateTransition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StateEvidenceLink" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "evidenceKind" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StateEvidenceLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvidenceDebtItem" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "subjectKind" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "importance" TEXT NOT NULL DEFAULT 'MEDIUM',
  "freshnessBand" TEXT,
  "confidenceBand" TEXT,
  "independentSources" INTEGER NOT NULL DEFAULT 0,
  "goalDependencyCount" INTEGER NOT NULL DEFAULT 0,
  "opportunityDependencyCount" INTEGER NOT NULL DEFAULT 0,
  "decisionDependencyCount" INTEGER NOT NULL DEFAULT 0,
  "consequenceBand" TEXT NOT NULL DEFAULT 'MEDIUM',
  "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" "EvidenceDebtStatus" NOT NULL DEFAULT 'OPEN',
  "recommendedAction" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EvidenceDebtItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Decision" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "problemSummary" TEXT NOT NULL,
  "decisionType" TEXT NOT NULL,
  "status" "DecisionStatus" NOT NULL DEFAULT 'DRAFT',
  "goalId" TEXT,
  "kpiDefinitionId" TEXT,
  "opportunityId" TEXT,
  "riskBand" TEXT,
  "confidenceBand" TEXT,
  "uncertaintyBand" TEXT,
  "expectedImpactDirection" TEXT,
  "estimatedCostCents" INTEGER,
  "ownerUserId" TEXT,
  "agentVersion" TEXT,
  "approvalRequestId" TEXT,
  "selectedAlternativeId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "missionId" TEXT,
  "rationaleSummary" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionAlternative" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "alternativeKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "summary" TEXT,
  "expectedDirection" TEXT,
  "potentialValueBand" TEXT,
  "estimatedCostCents" INTEGER,
  "timeToImpactBand" TEXT,
  "riskBand" TEXT,
  "confidenceBand" TEXT,
  "goalAlignment" DOUBLE PRECISION,
  "processCapacityBand" TEXT,
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "rejected" BOOLEAN NOT NULL DEFAULT false,
  "rejectionReason" TEXT,
  "rankScore" DOUBLE PRECISION,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionAlternative_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionEvidenceLink" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "evidenceKind" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'supports',
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionEvidenceLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionOutcome" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "outcomeKind" TEXT NOT NULL,
  "outcomeRef" TEXT,
  "kpiEffectDirection" TEXT,
  "attribution" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "measuredValue" DOUBLE PRECISION,
  "notes" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionOutcome_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionStateReference" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "asOf" TIMESTAMP(3) NOT NULL,
  "snapshotId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionStateReference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CreativeFeatureSet" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "contentPieceId" TEXT,
  "socialContentId" TEXT,
  "contentVersionId" TEXT,
  "extractorVersion" TEXT NOT NULL,
  "platform" TEXT,
  "format" TEXT,
  "topic" TEXT,
  "hookType" TEXT,
  "angle" TEXT,
  "lengthChars" INTEGER,
  "ctaPresent" BOOLEAN,
  "ctaType" TEXT,
  "tone" TEXT,
  "visualStructure" TEXT,
  "postingWindow" TEXT,
  "audienceKey" TEXT,
  "campaignId" TEXT,
  "goalId" TEXT,
  "features" JSONB NOT NULL DEFAULT '{}',
  "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreativeFeatureSet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CreativePattern" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "patternKey" TEXT NOT NULL,
  "featureCombo" JSONB NOT NULL,
  "sampleSize" INTEGER NOT NULL DEFAULT 0,
  "maturity" "CreativePatternMaturity" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreativePattern_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProcessDefinition" (
  "id" TEXT NOT NULL,
  "processKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "stages" JSONB NOT NULL DEFAULT '[]',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProcessDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProcessTransitionStat" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "processKey" TEXT NOT NULL,
  "fromStage" TEXT NOT NULL,
  "toStage" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "transitionCount" INTEGER NOT NULL DEFAULT 0,
  "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
  "p50DurationMs" INTEGER,
  "p90DurationMs" INTEGER,
  "conversionRate" DOUBLE PRECISION,
  "dropOffRate" DOUBLE PRECISION,
  "loopCount" INTEGER NOT NULL DEFAULT 0,
  "humanInterventionCount" INTEGER NOT NULL DEFAULT 0,
  "approvalDelayMs" INTEGER,
  "automationCoverage" DOUBLE PRECISION,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessTransitionStat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AutomationOpportunity" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "processKey" TEXT NOT NULL,
  "fromStage" TEXT NOT NULL,
  "toStage" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "volume" INTEGER NOT NULL DEFAULT 0,
  "stabilityScore" DOUBLE PRECISION,
  "delayMs" INTEGER,
  "errorRate" DOUBLE PRECISION,
  "riskBand" TEXT NOT NULL DEFAULT 'MEDIUM',
  "impactBand" TEXT NOT NULL DEFAULT 'MEDIUM',
  "confidenceBand" TEXT NOT NULL DEFAULT 'LOW',
  "status" "AutomationOpportunityStatus" NOT NULL DEFAULT 'DETECTED',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationOpportunity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CounterfactualRun" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "decisionId" TEXT,
  "goalId" TEXT,
  "opportunityId" TEXT,
  "maturity" "CounterfactualMaturity" NOT NULL DEFAULT 'EVIDENCE_COMPARISON',
  "ranking" JSONB NOT NULL DEFAULT '[]',
  "explanationFactors" JSONB NOT NULL DEFAULT '[]',
  "insufficientEvidence" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CounterfactualRun_pkey" PRIMARY KEY ("id")
);

-- Uniques / indexes
CREATE UNIQUE INDEX IF NOT EXISTS "ComputeAggregate_organisationId_windowStart_mode_taskType_key" ON "ComputeAggregate"("organisationId", "windowStart", "mode", "taskType");
CREATE INDEX IF NOT EXISTS "ComputeDecision_organisationId_createdAt_idx" ON "ComputeDecision"("organisationId", "createdAt");
CREATE INDEX IF NOT EXISTS "ComputeDecision_organisationId_executionMode_createdAt_idx" ON "ComputeDecision"("organisationId", "executionMode", "createdAt");
CREATE INDEX IF NOT EXISTS "ComputeDecision_organisationId_taskType_createdAt_idx" ON "ComputeDecision"("organisationId", "taskType", "createdAt");
CREATE INDEX IF NOT EXISTS "ComputeAggregate_organisationId_windowStart_idx" ON "ComputeAggregate"("organisationId", "windowStart");

CREATE UNIQUE INDEX IF NOT EXISTS "ToolTrustRecord_organisationId_toolKey_key" ON "ToolTrustRecord"("organisationId", "toolKey");
CREATE INDEX IF NOT EXISTS "ToolTrustRecord_toolKey_status_idx" ON "ToolTrustRecord"("toolKey", "status");
CREATE INDEX IF NOT EXISTS "ToolTrustRecord_status_updatedAt_idx" ON "ToolTrustRecord"("status", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "StateDefinition_entityType_dimension_key" ON "StateDefinition"("entityType", "dimension");
CREATE INDEX IF NOT EXISTS "StateDefinition_entityType_active_idx" ON "StateDefinition"("entityType", "active");

CREATE UNIQUE INDEX IF NOT EXISTS "StateSnapshot_organisationId_entityType_entityId_dimension_key" ON "StateSnapshot"("organisationId", "entityType", "entityId", "dimension");
CREATE INDEX IF NOT EXISTS "StateSnapshot_organisationId_entityType_dimension_idx" ON "StateSnapshot"("organisationId", "entityType", "dimension");
CREATE INDEX IF NOT EXISTS "StateSnapshot_organisationId_asOf_idx" ON "StateSnapshot"("organisationId", "asOf");

CREATE INDEX IF NOT EXISTS "StateTransition_organisationId_entityType_entityId_createdAt_idx" ON "StateTransition"("organisationId", "entityType", "entityId", "createdAt");
CREATE INDEX IF NOT EXISTS "StateTransition_organisationId_dimension_createdAt_idx" ON "StateTransition"("organisationId", "dimension", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "StateEvidenceLink_snapshotId_evidenceKind_evidenceId_key" ON "StateEvidenceLink"("snapshotId", "evidenceKind", "evidenceId");
CREATE INDEX IF NOT EXISTS "StateEvidenceLink_organisationId_evidenceKind_evidenceId_idx" ON "StateEvidenceLink"("organisationId", "evidenceKind", "evidenceId");

CREATE UNIQUE INDEX IF NOT EXISTS "EvidenceDebtItem_organisationId_subjectKind_subjectId_key" ON "EvidenceDebtItem"("organisationId", "subjectKind", "subjectId");
CREATE INDEX IF NOT EXISTS "EvidenceDebtItem_organisationId_status_priorityScore_idx" ON "EvidenceDebtItem"("organisationId", "status", "priorityScore");
CREATE INDEX IF NOT EXISTS "EvidenceDebtItem_organisationId_updatedAt_idx" ON "EvidenceDebtItem"("organisationId", "updatedAt");

CREATE INDEX IF NOT EXISTS "Decision_organisationId_status_createdAt_idx" ON "Decision"("organisationId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "Decision_organisationId_decisionType_createdAt_idx" ON "Decision"("organisationId", "decisionType", "createdAt");
CREATE INDEX IF NOT EXISTS "Decision_goalId_idx" ON "Decision"("goalId");
CREATE INDEX IF NOT EXISTS "Decision_opportunityId_idx" ON "Decision"("opportunityId");

CREATE UNIQUE INDEX IF NOT EXISTS "DecisionAlternative_decisionId_alternativeKey_key" ON "DecisionAlternative"("decisionId", "alternativeKey");
CREATE INDEX IF NOT EXISTS "DecisionAlternative_organisationId_decisionId_idx" ON "DecisionAlternative"("organisationId", "decisionId");

CREATE UNIQUE INDEX IF NOT EXISTS "DecisionEvidenceLink_decisionId_evidenceKind_evidenceId_role_key" ON "DecisionEvidenceLink"("decisionId", "evidenceKind", "evidenceId", "role");
CREATE INDEX IF NOT EXISTS "DecisionEvidenceLink_organisationId_evidenceKind_idx" ON "DecisionEvidenceLink"("organisationId", "evidenceKind");

CREATE INDEX IF NOT EXISTS "DecisionOutcome_organisationId_decisionId_recordedAt_idx" ON "DecisionOutcome"("organisationId", "decisionId", "recordedAt");
CREATE INDEX IF NOT EXISTS "DecisionOutcome_organisationId_outcomeKind_recordedAt_idx" ON "DecisionOutcome"("organisationId", "outcomeKind", "recordedAt");

CREATE INDEX IF NOT EXISTS "DecisionStateReference_organisationId_decisionId_idx" ON "DecisionStateReference"("organisationId", "decisionId");
CREATE INDEX IF NOT EXISTS "DecisionStateReference_decisionId_entityType_dimension_idx" ON "DecisionStateReference"("decisionId", "entityType", "dimension");

CREATE UNIQUE INDEX IF NOT EXISTS "CreativeFeatureSet_organisationId_contentPieceId_extractorVersion_key" ON "CreativeFeatureSet"("organisationId", "contentPieceId", "extractorVersion");
CREATE INDEX IF NOT EXISTS "CreativeFeatureSet_organisationId_platform_topic_idx" ON "CreativeFeatureSet"("organisationId", "platform", "topic");
CREATE INDEX IF NOT EXISTS "CreativeFeatureSet_organisationId_extractorVersion_idx" ON "CreativeFeatureSet"("organisationId", "extractorVersion");

CREATE UNIQUE INDEX IF NOT EXISTS "CreativePattern_organisationId_patternKey_key" ON "CreativePattern"("organisationId", "patternKey");
CREATE INDEX IF NOT EXISTS "CreativePattern_organisationId_maturity_sampleSize_idx" ON "CreativePattern"("organisationId", "maturity", "sampleSize");

CREATE UNIQUE INDEX IF NOT EXISTS "ProcessDefinition_processKey_key" ON "ProcessDefinition"("processKey");

CREATE UNIQUE INDEX IF NOT EXISTS "ProcessTransitionStat_organisationId_processKey_fromStage_toStage_windowStart_key" ON "ProcessTransitionStat"("organisationId", "processKey", "fromStage", "toStage", "windowStart");
CREATE INDEX IF NOT EXISTS "ProcessTransitionStat_organisationId_processKey_windowStart_idx" ON "ProcessTransitionStat"("organisationId", "processKey", "windowStart");

CREATE INDEX IF NOT EXISTS "AutomationOpportunity_organisationId_status_createdAt_idx" ON "AutomationOpportunity"("organisationId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "AutomationOpportunity_organisationId_processKey_idx" ON "AutomationOpportunity"("organisationId", "processKey");

CREATE INDEX IF NOT EXISTS "CounterfactualRun_organisationId_createdAt_idx" ON "CounterfactualRun"("organisationId", "createdAt");
CREATE INDEX IF NOT EXISTS "CounterfactualRun_decisionId_idx" ON "CounterfactualRun"("decisionId");

CREATE INDEX IF NOT EXISTS "AgentMission_decisionId_idx" ON "AgentMission"("decisionId");

-- Foreign keys
ALTER TABLE "ComputeDecision" ADD CONSTRAINT "ComputeDecision_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComputeAggregate" ADD CONSTRAINT "ComputeAggregate_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StateSnapshot" ADD CONSTRAINT "StateSnapshot_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StateSnapshot" ADD CONSTRAINT "StateSnapshot_stateDefinitionId_fkey" FOREIGN KEY ("stateDefinitionId") REFERENCES "StateDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StateTransition" ADD CONSTRAINT "StateTransition_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StateTransition" ADD CONSTRAINT "StateTransition_fromSnapshotId_fkey" FOREIGN KEY ("fromSnapshotId") REFERENCES "StateSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StateTransition" ADD CONSTRAINT "StateTransition_toSnapshotId_fkey" FOREIGN KEY ("toSnapshotId") REFERENCES "StateSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StateEvidenceLink" ADD CONSTRAINT "StateEvidenceLink_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StateEvidenceLink" ADD CONSTRAINT "StateEvidenceLink_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "StateSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceDebtItem" ADD CONSTRAINT "EvidenceDebtItem_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionAlternative" ADD CONSTRAINT "DecisionAlternative_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionAlternative" ADD CONSTRAINT "DecisionAlternative_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionEvidenceLink" ADD CONSTRAINT "DecisionEvidenceLink_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionEvidenceLink" ADD CONSTRAINT "DecisionEvidenceLink_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionStateReference" ADD CONSTRAINT "DecisionStateReference_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionStateReference" ADD CONSTRAINT "DecisionStateReference_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreativeFeatureSet" ADD CONSTRAINT "CreativeFeatureSet_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreativePattern" ADD CONSTRAINT "CreativePattern_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcessTransitionStat" ADD CONSTRAINT "ProcessTransitionStat_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcessTransitionStat" ADD CONSTRAINT "ProcessTransitionStat_processKey_fkey" FOREIGN KEY ("processKey") REFERENCES "ProcessDefinition"("processKey") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationOpportunity" ADD CONSTRAINT "AutomationOpportunity_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CounterfactualRun" ADD CONSTRAINT "CounterfactualRun_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CounterfactualRun" ADD CONSTRAINT "CounterfactualRun_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentMission" ADD CONSTRAINT "AgentMission_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
