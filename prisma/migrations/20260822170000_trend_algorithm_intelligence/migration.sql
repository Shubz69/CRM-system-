-- Phase 5: Trend lifecycle, algorithm changes, probabilistic forecasts + outcomes.

CREATE TYPE "TrendLifecycleState" AS ENUM (
  'EMERGING', 'ACCELERATING', 'BREAKOUT', 'MAINSTREAM', 'SATURATED', 'DECLINING', 'RECURRING'
);
CREATE TYPE "AlgorithmEvidenceKind" AS ENUM ('OFFICIAL', 'OBSERVATIONAL', 'UNKNOWN');
CREATE TYPE "TrendForecastHorizon" AS ENUM ('H24', 'D3', 'D7', 'D30');

CREATE TABLE "TrendCluster" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'theme',
    "state" "TrendLifecycleState" NOT NULL DEFAULT 'EMERGING',
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "features" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrendCluster_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrendCluster_organisationId_key_key" ON "TrendCluster"("organisationId", "key");
CREATE INDEX "TrendCluster_organisationId_state_lastSeenAt_idx" ON "TrendCluster"("organisationId", "state", "lastSeenAt");
CREATE INDEX "TrendCluster_organisationId_kind_lastSeenAt_idx" ON "TrendCluster"("organisationId", "kind", "lastSeenAt");

ALTER TABLE "TrendCluster"
  ADD CONSTRAINT "TrendCluster_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TrendFeatureSnapshot" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "trendClusterId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mentionCount" INTEGER NOT NULL DEFAULT 0,
    "contentCount" INTEGER NOT NULL DEFAULT 0,
    "velocity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "acceleration" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "crossPlatformCount" INTEGER NOT NULL DEFAULT 0,
    "engagementScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "features" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendFeatureSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrendFeatureSnapshot_organisationId_trendClusterId_capturedAt_idx"
  ON "TrendFeatureSnapshot"("organisationId", "trendClusterId", "capturedAt");
CREATE INDEX "TrendFeatureSnapshot_organisationId_window_capturedAt_idx"
  ON "TrendFeatureSnapshot"("organisationId", "window", "capturedAt");

ALTER TABLE "TrendFeatureSnapshot"
  ADD CONSTRAINT "TrendFeatureSnapshot_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrendFeatureSnapshot"
  ADD CONSTRAINT "TrendFeatureSnapshot_trendClusterId_fkey"
  FOREIGN KEY ("trendClusterId") REFERENCES "TrendCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AlgorithmChange" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "surface" TEXT,
    "changeType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "evidenceKind" "AlgorithmEvidenceKind" NOT NULL DEFAULT 'UNKNOWN',
    "confidence" DOUBLE PRECISION,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveAt" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "affectedFormats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedImpact" TEXT,
    "recommendedExperiment" TEXT,
    "validationNotes" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlgorithmChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlgorithmChange_organisationId_platform_detectedAt_idx"
  ON "AlgorithmChange"("organisationId", "platform", "detectedAt");
CREATE INDEX "AlgorithmChange_organisationId_evidenceKind_detectedAt_idx"
  ON "AlgorithmChange"("organisationId", "evidenceKind", "detectedAt");

ALTER TABLE "AlgorithmChange"
  ADD CONSTRAINT "AlgorithmChange_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TrendForecast" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "trendClusterId" TEXT NOT NULL,
    "horizon" "TrendForecastHorizon" NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "uncertainty" DOUBLE PRECISION NOT NULL,
    "drivers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "counterSignals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "featureSnapshotId" TEXT,
    "confidenceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolveAfter" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrendForecast_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrendForecast_organisationId_trendClusterId_createdAt_idx"
  ON "TrendForecast"("organisationId", "trendClusterId", "createdAt");
CREATE INDEX "TrendForecast_organisationId_resolveAfter_idx"
  ON "TrendForecast"("organisationId", "resolveAfter");
CREATE INDEX "TrendForecast_organisationId_horizon_createdAt_idx"
  ON "TrendForecast"("organisationId", "horizon", "createdAt");

ALTER TABLE "TrendForecast"
  ADD CONSTRAINT "TrendForecast_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrendForecast"
  ADD CONSTRAINT "TrendForecast_trendClusterId_fkey"
  FOREIGN KEY ("trendClusterId") REFERENCES "TrendCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TrendForecastOutcome" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "trendForecastId" TEXT NOT NULL,
    "realizedPositive" BOOLEAN NOT NULL,
    "realizedState" "TrendLifecycleState",
    "notes" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendForecastOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrendForecastOutcome_trendForecastId_key" ON "TrendForecastOutcome"("trendForecastId");
CREATE INDEX "TrendForecastOutcome_organisationId_evaluatedAt_idx"
  ON "TrendForecastOutcome"("organisationId", "evaluatedAt");

ALTER TABLE "TrendForecastOutcome"
  ADD CONSTRAINT "TrendForecastOutcome_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrendForecastOutcome"
  ADD CONSTRAINT "TrendForecastOutcome_trendForecastId_fkey"
  FOREIGN KEY ("trendForecastId") REFERENCES "TrendForecast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
