-- Phase 14F + 15–18 additive completion (Track 5 consolidated).
-- Never use prisma db push on populated DBs.

-- PublishingJobStatus extensions
ALTER TYPE "PublishingJobStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TYPE "PublishingJobStatus" ADD VALUE IF NOT EXISTS 'DISPATCHING';
ALTER TYPE "PublishingJobStatus" ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';

-- MissionExternalOutcome: PREPARED
ALTER TYPE "MissionExternalOutcome" ADD VALUE IF NOT EXISTS 'PREPARED';

-- Verification / quality enums
CREATE TYPE "VerificationBudget" AS ENUM ('FAST', 'STANDARD', 'DEEP', 'MISSION_CRITICAL');
CREATE TYPE "OpportunityQualityGate" AS ENUM (
  'PENDING_VERIFICATION',
  'PASSED',
  'NEEDS_MORE_RESEARCH',
  'CONFLICTED',
  'INSUFFICIENT_EVIDENCE',
  'STALE',
  'REJECTED'
);
CREATE TYPE "IntelligenceClaimStatus" AS ENUM (
  'EXTRACTED',
  'CORROBORATED',
  'CONFLICTED',
  'INSUFFICIENT',
  'REJECTED'
);
CREATE TYPE "PredictionEvaluationStatus" AS ENUM ('PENDING', 'SCORED', 'EXPIRED', 'INVALID');

-- PublishingJob Phase 15 ledger columns
ALTER TABLE "PublishingJob"
  ADD COLUMN IF NOT EXISTS "externalOutcome" "MissionExternalOutcome" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "lastDispatchAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reconciliationNote" TEXT,
  ADD COLUMN IF NOT EXISTS "missionId" TEXT,
  ADD COLUMN IF NOT EXISTS "approvalRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "PublishingJob_organisationId_idempotencyKey_key"
  ON "PublishingJob"("organisationId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "PublishingJob_organisationId_externalOutcome_status_idx"
  ON "PublishingJob"("organisationId", "externalOutcome", "status");

-- QualityAssessment before BusinessOpportunity FK
CREATE TABLE "QualityAssessment" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "subjectKind" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "budget" "VerificationBudget" NOT NULL DEFAULT 'STANDARD',
  "gateStatus" "OpportunityQualityGate" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "dimensions" JSONB NOT NULL DEFAULT '{}',
  "criticNotes" TEXT,
  "escalationReason" TEXT,
  "consequenceLevel" TEXT NOT NULL DEFAULT 'MEDIUM',
  "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QualityAssessment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "QualityAssessment_organisationId_subjectKind_subjectId_idx"
  ON "QualityAssessment"("organisationId", "subjectKind", "subjectId");
CREATE INDEX "QualityAssessment_organisationId_gateStatus_assessedAt_idx"
  ON "QualityAssessment"("organisationId", "gateStatus", "assessedAt");
ALTER TABLE "QualityAssessment"
  ADD CONSTRAINT "QualityAssessment_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessOpportunity"
  ADD COLUMN IF NOT EXISTS "qualityGateStatus" "OpportunityQualityGate" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  ADD COLUMN IF NOT EXISTS "qualityAssessmentId" TEXT,
  ADD COLUMN IF NOT EXISTS "verificationBudget" "VerificationBudget" NOT NULL DEFAULT 'STANDARD';
CREATE INDEX IF NOT EXISTS "BusinessOpportunity_organisationId_qualityGateStatus_idx"
  ON "BusinessOpportunity"("organisationId", "qualityGateStatus");
ALTER TABLE "BusinessOpportunity"
  ADD CONSTRAINT "BusinessOpportunity_qualityAssessmentId_fkey"
  FOREIGN KEY ("qualityAssessmentId") REFERENCES "QualityAssessment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "IntelligenceClaim" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "researchJobId" TEXT,
  "text" TEXT NOT NULL,
  "normalisedKey" TEXT NOT NULL,
  "claimKind" TEXT NOT NULL DEFAULT 'FACT',
  "status" "IntelligenceClaimStatus" NOT NULL DEFAULT 'EXTRACTED',
  "authorityScore" DOUBLE PRECISION,
  "freshnessScore" DOUBLE PRECISION,
  "corroborationScore" DOUBLE PRECISION,
  "independenceScore" DOUBLE PRECISION,
  "audienceRelevanceScore" DOUBLE PRECISION,
  "platformRelevanceScore" DOUBLE PRECISION,
  "geoRelevanceScore" DOUBLE PRECISION,
  "sampleSizeScore" DOUBLE PRECISION,
  "socialQualityScore" DOUBLE PRECISION,
  "survivorshipRisk" DOUBLE PRECISION,
  "negativeEvidenceScore" DOUBLE PRECISION,
  "dimensions" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntelligenceClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntelligenceClaim_organisationId_normalisedKey_key"
  ON "IntelligenceClaim"("organisationId", "normalisedKey");
CREATE INDEX "IntelligenceClaim_organisationId_status_createdAt_idx"
  ON "IntelligenceClaim"("organisationId", "status", "createdAt");
CREATE INDEX "IntelligenceClaim_organisationId_researchJobId_idx"
  ON "IntelligenceClaim"("organisationId", "researchJobId");
ALTER TABLE "IntelligenceClaim"
  ADD CONSTRAINT "IntelligenceClaim_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ClaimEvidenceLink" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "researchSourceId" TEXT,
  "researchSnapshotId" TEXT,
  "researchFindingId" TEXT,
  "providerKey" TEXT,
  "sourceUrl" TEXT,
  "retrievedAt" TIMESTAMP(3),
  "lineageKey" TEXT,
  "supports" BOOLEAN NOT NULL DEFAULT true,
  "excerpt" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClaimEvidenceLink_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClaimEvidenceLink_claimId_idx" ON "ClaimEvidenceLink"("claimId");
CREATE INDEX "ClaimEvidenceLink_organisationId_lineageKey_idx"
  ON "ClaimEvidenceLink"("organisationId", "lineageKey");
CREATE INDEX "ClaimEvidenceLink_organisationId_researchSnapshotId_idx"
  ON "ClaimEvidenceLink"("organisationId", "researchSnapshotId");
ALTER TABLE "ClaimEvidenceLink"
  ADD CONSTRAINT "ClaimEvidenceLink_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "IntelligenceClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "QualityAssessmentClaim" (
  "id" TEXT NOT NULL,
  "qualityAssessmentId" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'PRIMARY',
  CONSTRAINT "QualityAssessmentClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QualityAssessmentClaim_qualityAssessmentId_claimId_key"
  ON "QualityAssessmentClaim"("qualityAssessmentId", "claimId");
CREATE INDEX "QualityAssessmentClaim_claimId_idx" ON "QualityAssessmentClaim"("claimId");
ALTER TABLE "QualityAssessmentClaim"
  ADD CONSTRAINT "QualityAssessmentClaim_qualityAssessmentId_fkey"
  FOREIGN KEY ("qualityAssessmentId") REFERENCES "QualityAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QualityAssessmentClaim"
  ADD CONSTRAINT "QualityAssessmentClaim_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "IntelligenceClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContinuousCollectionRun" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "providerKey" TEXT,
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "itemsCollected" INTEGER NOT NULL DEFAULT 0,
  "errorSummary" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContinuousCollectionRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContinuousCollectionRun_organisationId_kind_observedAt_idx"
  ON "ContinuousCollectionRun"("organisationId", "kind", "observedAt");
ALTER TABLE "ContinuousCollectionRun"
  ADD CONSTRAINT "ContinuousCollectionRun_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IntelligencePrediction" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "predictionType" TEXT NOT NULL,
  "statement" TEXT NOT NULL,
  "horizonAt" TIMESTAMP(3) NOT NULL,
  "features" JSONB NOT NULL DEFAULT '{}',
  "modelVersion" TEXT NOT NULL DEFAULT 'rules-v1',
  "confidenceBand" TEXT NOT NULL DEFAULT 'MEDIUM',
  "expectedOutcome" JSONB NOT NULL DEFAULT '{}',
  "actualOutcome" JSONB,
  "evaluationStatus" "PredictionEvaluationStatus" NOT NULL DEFAULT 'PENDING',
  "trendClusterId" TEXT,
  "qualityAssessmentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "scoredAt" TIMESTAMP(3),
  CONSTRAINT "IntelligencePrediction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IntelligencePrediction_organisationId_predictionType_evaluationStatus_idx"
  ON "IntelligencePrediction"("organisationId", "predictionType", "evaluationStatus");
CREATE INDEX "IntelligencePrediction_organisationId_horizonAt_idx"
  ON "IntelligencePrediction"("organisationId", "horizonAt");
CREATE INDEX "IntelligencePrediction_organisationId_trendClusterId_idx"
  ON "IntelligencePrediction"("organisationId", "trendClusterId");
ALTER TABLE "IntelligencePrediction"
  ADD CONSTRAINT "IntelligencePrediction_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PredictionEvaluation" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "predictionId" TEXT NOT NULL,
  "directionCorrect" BOOLEAN,
  "precisionNote" TEXT,
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "scorerVersion" TEXT NOT NULL DEFAULT 'rules-v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PredictionEvaluation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PredictionEvaluation_organisationId_predictionId_idx"
  ON "PredictionEvaluation"("organisationId", "predictionId");
ALTER TABLE "PredictionEvaluation"
  ADD CONSTRAINT "PredictionEvaluation_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PredictionEvaluation"
  ADD CONSTRAINT "PredictionEvaluation_predictionId_fkey"
  FOREIGN KEY ("predictionId") REFERENCES "IntelligencePrediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConfidenceCalibrationSample" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "subjectKind" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "statedBand" TEXT NOT NULL,
  "wasCorrect" BOOLEAN,
  "outcomeKind" TEXT,
  "sampleCountHint" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfidenceCalibrationSample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConfidenceCalibrationSample_organisationId_subjectKind_statedBand_idx"
  ON "ConfidenceCalibrationSample"("organisationId", "subjectKind", "statedBand");
CREATE INDEX "ConfidenceCalibrationSample_organisationId_createdAt_idx"
  ON "ConfidenceCalibrationSample"("organisationId", "createdAt");
ALTER TABLE "ConfidenceCalibrationSample"
  ADD CONSTRAINT "ConfidenceCalibrationSample_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VersionPerformanceSnapshot" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT,
  "artifactKind" TEXT NOT NULL,
  "artifactKey" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "rolloutState" TEXT NOT NULL DEFAULT 'CURRENT',
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "sampleSize" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VersionPerformanceSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VersionPerformanceSnapshot_artifactKind_artifactKey_version_idx"
  ON "VersionPerformanceSnapshot"("artifactKind", "artifactKey", "version");
CREATE INDEX "VersionPerformanceSnapshot_organisationId_artifactKind_createdAt_idx"
  ON "VersionPerformanceSnapshot"("organisationId", "artifactKind", "createdAt");
ALTER TABLE "VersionPerformanceSnapshot"
  ADD CONSTRAINT "VersionPerformanceSnapshot_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OperationalSloSnapshot" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "indicators" JSONB NOT NULL DEFAULT '{}',
  "maturityNote" TEXT NOT NULL DEFAULT 'FOUNDATION',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperationalSloSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OperationalSloSnapshot_organisationId_capturedAt_idx"
  ON "OperationalSloSnapshot"("organisationId", "capturedAt");
CREATE INDEX "OperationalSloSnapshot_capturedAt_idx" ON "OperationalSloSnapshot"("capturedAt");
ALTER TABLE "OperationalSloSnapshot"
  ADD CONSTRAINT "OperationalSloSnapshot_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CostOutcomeLink" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "costCents" INTEGER NOT NULL,
  "costKind" TEXT NOT NULL,
  "outcomeKind" TEXT NOT NULL,
  "outcomeRef" TEXT,
  "attribution" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostOutcomeLink_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CostOutcomeLink_organisationId_outcomeKind_createdAt_idx"
  ON "CostOutcomeLink"("organisationId", "outcomeKind", "createdAt");
CREATE INDEX "CostOutcomeLink_organisationId_costKind_createdAt_idx"
  ON "CostOutcomeLink"("organisationId", "costKind", "createdAt");
ALTER TABLE "CostOutcomeLink"
  ADD CONSTRAINT "CostOutcomeLink_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
