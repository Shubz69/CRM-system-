-- Phase 13 — Goal/KPI graph, Digital Twin relations, Business Opportunity graph
-- Additive only. Safe for prisma migrate deploy.

-- Enums
CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'ACTIVE', 'AT_RISK', 'ACHIEVED', 'PAUSED', 'CANCELLED');
CREATE TYPE "GoalCategory" AS ENUM ('REVENUE', 'PIPELINE', 'SALES', 'CUSTOMER_ACQUISITION', 'RETENTION', 'CONTENT', 'BRAND', 'AUDIENCE_GROWTH', 'OPERATIONAL', 'CUSTOM');
CREATE TYPE "KpiAggregation" AS ENUM ('SUM', 'AVG', 'COUNT', 'RATE', 'LAST');
CREATE TYPE "KpiDirection" AS ENUM ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER');
CREATE TYPE "KpiTargetComparator" AS ENUM ('GTE', 'LTE', 'EQ', 'RANGE', 'PCT_IMPROVEMENT', 'ABS_IMPROVEMENT');
CREATE TYPE "InitiativeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'PAUSED', 'CANCELLED');
CREATE TYPE "GoalLinkKind" AS ENUM ('RELATED_TO', 'EXPECTED_TO_IMPACT', 'MEASURED_IMPACT', 'CONTRIBUTED_TO');
CREATE TYPE "BusinessClaimStatus" AS ENUM ('CONFIRMED', 'OBSERVED', 'INFERRED', 'DISPUTED', 'STALE');
CREATE TYPE "ProductOfferingStatus" AS ENUM ('ACTIVE', 'DRAFT', 'ARCHIVED');
CREATE TYPE "BusinessOpportunityType" AS ENUM ('TREND', 'CONTENT_GAP', 'AUDIENCE_NEED', 'COMPETITOR_GAP', 'LEAD', 'DEAL_RISK', 'REACTIVATION', 'UPSELL', 'CROSS_SELL', 'CAMPAIGN', 'SEO', 'AUTOMATION', 'OPERATIONAL', 'RESEARCH', 'CUSTOM');
CREATE TYPE "BusinessOpportunityStatus" AS ENUM ('DETECTED', 'REVIEWED', 'ACCEPTED', 'REJECTED', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'DISMISSED');
CREATE TYPE "OpportunityConfidenceBand" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "OpportunityImpactBand" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH');
CREATE TYPE "OpportunityUrgencyBand" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "OpportunityOutcomeResult" AS ENUM ('SUCCESSFUL', 'UNSUCCESSFUL', 'INCONCLUSIVE', 'IGNORED');

-- Goal
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "GoalCategory" NOT NULL DEFAULT 'CUSTOM',
    "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "ownerUserId" TEXT,
    "parentGoalId" TEXT,
    "startAt" TIMESTAMP(3),
    "targetAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'user',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KpiDefinition" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL,
    "aggregation" "KpiAggregation" NOT NULL DEFAULT 'SUM',
    "direction" "KpiDirection" NOT NULL DEFAULT 'HIGHER_IS_BETTER',
    "calculatorKey" TEXT NOT NULL,
    "measurementFreq" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KpiDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KpiTarget" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "kpiDefinitionId" TEXT NOT NULL,
    "comparator" "KpiTargetComparator" NOT NULL DEFAULT 'GTE',
    "targetValue" DOUBLE PRECISION NOT NULL,
    "targetValueMax" DOUBLE PRECISION,
    "baselineValue" DOUBLE PRECISION,
    "unit" TEXT NOT NULL,
    "currency" TEXT,
    "deadlineAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KpiTarget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KpiSnapshot" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "kpiDefinitionId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceReference" TEXT,
    "confidence" DOUBLE PRECISION,
    "calculationVersion" TEXT NOT NULL DEFAULT '1',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KpiSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Initiative" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "goalId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "InitiativeStatus" NOT NULL DEFAULT 'DRAFT',
    "campaignId" TEXT,
    "experimentId" TEXT,
    "missionId" TEXT,
    "automationRuleId" TEXT,
    "contentPieceId" TEXT,
    "opportunityId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Initiative_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoalLink" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "kind" "GoalLinkKind" NOT NULL DEFAULT 'RELATED_TO',
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "kpiDefinitionId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoalLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductOffering" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "priceMinCents" INTEGER,
    "priceMaxCents" INTEGER,
    "currency" TEXT DEFAULT 'GBP',
    "status" "ProductOfferingStatus" NOT NULL DEFAULT 'ACTIVE',
    "targetAudience" TEXT,
    "businessModel" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductOffering_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AudienceSegment" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "evidenceNote" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AudienceSegment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EntityRelation" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "relationshipType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EntityRelation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessClaim" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "objectType" TEXT,
    "objectId" TEXT,
    "valueText" TEXT,
    "valueJson" JSONB,
    "status" "BusinessClaimStatus" NOT NULL DEFAULT 'OBSERVED',
    "confidence" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessClaim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessOpportunity" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "type" "BusinessOpportunityType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "BusinessOpportunityStatus" NOT NULL DEFAULT 'DETECTED',
    "impact" "OpportunityImpactBand" NOT NULL DEFAULT 'MEDIUM',
    "urgency" "OpportunityUrgencyBand" NOT NULL DEFAULT 'MEDIUM',
    "confidence" "OpportunityConfidenceBand" NOT NULL DEFAULT 'MEDIUM',
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedEffort" TEXT,
    "estimatedValueCents" INTEGER,
    "currency" TEXT,
    "goalId" TEXT,
    "kpiDefinitionId" TEXT,
    "ownerUserId" TEXT,
    "createdByAgent" TEXT,
    "createdByVersion" TEXT,
    "source" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "scoreFactors" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessOpportunity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpportunityEvidence" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "evidenceId" TEXT,
    "label" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpportunityEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpportunityOutcome" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "result" "OpportunityOutcomeResult" NOT NULL DEFAULT 'INCONCLUSIVE',
    "summary" TEXT,
    "measuredValueCents" INTEGER,
    "currency" TEXT,
    "kpiSnapshotBeforeId" TEXT,
    "kpiSnapshotAfterId" TEXT,
    "userJudgement" TEXT,
    "agentEvaluation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OpportunityOutcome_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpportunityDetectorRun" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "detectorKey" TEXT NOT NULL,
    "detectorVersion" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "OpportunityDetectorRun_pkey" PRIMARY KEY ("id")
);

-- AgentMission Phase 13 FKs
ALTER TABLE "AgentMission" ADD COLUMN IF NOT EXISTS "businessOpportunityId" TEXT;

-- Indexes & uniques
CREATE INDEX "Goal_organisationId_status_priority_idx" ON "Goal"("organisationId", "status", "priority");
CREATE INDEX "Goal_organisationId_category_idx" ON "Goal"("organisationId", "category");
CREATE INDEX "Goal_parentGoalId_idx" ON "Goal"("parentGoalId");

CREATE UNIQUE INDEX "KpiDefinition_organisationId_key_key" ON "KpiDefinition"("organisationId", "key");
CREATE INDEX "KpiDefinition_organisationId_calculatorKey_idx" ON "KpiDefinition"("organisationId", "calculatorKey");

CREATE INDEX "KpiTarget_organisationId_goalId_idx" ON "KpiTarget"("organisationId", "goalId");
CREATE INDEX "KpiTarget_organisationId_kpiDefinitionId_idx" ON "KpiTarget"("organisationId", "kpiDefinitionId");
CREATE UNIQUE INDEX "KpiTarget_goalId_kpiDefinitionId_key" ON "KpiTarget"("goalId", "kpiDefinitionId");

CREATE INDEX "KpiSnapshot_organisationId_kpiDefinitionId_observedAt_idx" ON "KpiSnapshot"("organisationId", "kpiDefinitionId", "observedAt");
CREATE INDEX "KpiSnapshot_organisationId_observedAt_idx" ON "KpiSnapshot"("organisationId", "observedAt");

CREATE INDEX "Initiative_organisationId_status_idx" ON "Initiative"("organisationId", "status");
CREATE INDEX "Initiative_organisationId_goalId_idx" ON "Initiative"("organisationId", "goalId");

CREATE UNIQUE INDEX "GoalLink_goalId_kind_targetType_targetId_key" ON "GoalLink"("goalId", "kind", "targetType", "targetId");
CREATE INDEX "GoalLink_organisationId_targetType_targetId_idx" ON "GoalLink"("organisationId", "targetType", "targetId");

CREATE INDEX "ProductOffering_organisationId_status_idx" ON "ProductOffering"("organisationId", "status");
CREATE INDEX "AudienceSegment_organisationId_name_idx" ON "AudienceSegment"("organisationId", "name");

CREATE UNIQUE INDEX "EntityRelation_organisationId_sourceType_sourceId_relationshipType_targetType_targetId_key" ON "EntityRelation"("organisationId", "sourceType", "sourceId", "relationshipType", "targetType", "targetId");
CREATE INDEX "EntityRelation_organisationId_relationshipType_idx" ON "EntityRelation"("organisationId", "relationshipType");
CREATE INDEX "EntityRelation_organisationId_targetType_targetId_idx" ON "EntityRelation"("organisationId", "targetType", "targetId");

CREATE INDEX "BusinessClaim_organisationId_subjectType_subjectId_predicate_idx" ON "BusinessClaim"("organisationId", "subjectType", "subjectId", "predicate");
CREATE INDEX "BusinessClaim_organisationId_status_lastVerifiedAt_idx" ON "BusinessClaim"("organisationId", "status", "lastVerifiedAt");

CREATE UNIQUE INDEX "BusinessOpportunity_organisationId_dedupeKey_key" ON "BusinessOpportunity"("organisationId", "dedupeKey");
CREATE INDEX "BusinessOpportunity_organisationId_status_priorityScore_idx" ON "BusinessOpportunity"("organisationId", "status", "priorityScore");
CREATE INDEX "BusinessOpportunity_organisationId_type_status_idx" ON "BusinessOpportunity"("organisationId", "type", "status");
CREATE INDEX "BusinessOpportunity_organisationId_expiresAt_idx" ON "BusinessOpportunity"("organisationId", "expiresAt");
CREATE INDEX "BusinessOpportunity_goalId_idx" ON "BusinessOpportunity"("goalId");

CREATE INDEX "OpportunityEvidence_organisationId_opportunityId_idx" ON "OpportunityEvidence"("organisationId", "opportunityId");
CREATE INDEX "OpportunityEvidence_evidenceType_evidenceId_idx" ON "OpportunityEvidence"("evidenceType", "evidenceId");

CREATE UNIQUE INDEX "OpportunityOutcome_opportunityId_key" ON "OpportunityOutcome"("opportunityId");

CREATE INDEX "OpportunityDetectorRun_organisationId_detectorKey_startedAt_idx" ON "OpportunityDetectorRun"("organisationId", "detectorKey", "startedAt");

CREATE INDEX "AgentMission_businessOpportunityId_idx" ON "AgentMission"("businessOpportunityId");

-- Foreign keys
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_parentGoalId_fkey" FOREIGN KEY ("parentGoalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KpiDefinition" ADD CONSTRAINT "KpiDefinition_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KpiTarget" ADD CONSTRAINT "KpiTarget_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KpiTarget" ADD CONSTRAINT "KpiTarget_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KpiTarget" ADD CONSTRAINT "KpiTarget_kpiDefinitionId_fkey" FOREIGN KEY ("kpiDefinitionId") REFERENCES "KpiDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KpiSnapshot" ADD CONSTRAINT "KpiSnapshot_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KpiSnapshot" ADD CONSTRAINT "KpiSnapshot_kpiDefinitionId_fkey" FOREIGN KEY ("kpiDefinitionId") REFERENCES "KpiDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GoalLink" ADD CONSTRAINT "GoalLink_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoalLink" ADD CONSTRAINT "GoalLink_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductOffering" ADD CONSTRAINT "ProductOffering_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudienceSegment" ADD CONSTRAINT "AudienceSegment_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EntityRelation" ADD CONSTRAINT "EntityRelation_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessClaim" ADD CONSTRAINT "BusinessClaim_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessOpportunity" ADD CONSTRAINT "BusinessOpportunity_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessOpportunity" ADD CONSTRAINT "BusinessOpportunity_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BusinessOpportunity" ADD CONSTRAINT "BusinessOpportunity_kpiDefinitionId_fkey" FOREIGN KEY ("kpiDefinitionId") REFERENCES "KpiDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OpportunityEvidence" ADD CONSTRAINT "OpportunityEvidence_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityEvidence" ADD CONSTRAINT "OpportunityEvidence_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "BusinessOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpportunityOutcome" ADD CONSTRAINT "OpportunityOutcome_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityOutcome" ADD CONSTRAINT "OpportunityOutcome_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "BusinessOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpportunityDetectorRun" ADD CONSTRAINT "OpportunityDetectorRun_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentMission" ADD CONSTRAINT "AgentMission_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentMission" ADD CONSTRAINT "AgentMission_businessOpportunityId_fkey" FOREIGN KEY ("businessOpportunityId") REFERENCES "BusinessOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
