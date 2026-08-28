-- Phase 9 - Learning & Experimentation

CREATE TYPE "ExperimentStatus" AS ENUM ('DRAFT', 'RUNNING', 'COMPLETED', 'CANCELLED');
CREATE TYPE "AgentVersionCandidateStatus" AS ENUM ('DRAFT', 'EVALUATING', 'PASSED', 'FAILED', 'PROMOTED', 'REJECTED');
CREATE TYPE "EvalRunStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED');

CREATE TABLE "RecommendationFeedback" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "rating" INTEGER,
    "note" TEXT,
    "userId" TEXT,
    "outcomeMetric" TEXT,
    "outcomeValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationFeedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT',
    "variants" JSONB NOT NULL DEFAULT '[]',
    "primaryMetric" TEXT NOT NULL,
    "resultSummary" JSONB,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentVersionCandidate" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "agentConfigurationId" TEXT,
    "label" TEXT NOT NULL,
    "status" "AgentVersionCandidateStatus" NOT NULL DEFAULT 'DRAFT',
    "configSnapshot" JSONB NOT NULL DEFAULT '{}',
    "evalSuiteKey" TEXT,
    "lastEvalRunId" TEXT,
    "evalSummary" JSONB,
    "promotedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentVersionCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvalSuite" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cases" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalSuite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "evalSuiteId" TEXT,
    "suiteKey" TEXT NOT NULL,
    "candidateId" TEXT,
    "status" "EvalRunStatus" NOT NULL DEFAULT 'PENDING',
    "results" JSONB NOT NULL DEFAULT '{}',
    "passed" BOOLEAN,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecommendationFeedback_organisationId_subjectKind_createdAt_idx" ON "RecommendationFeedback"("organisationId", "subjectKind", "createdAt");
CREATE INDEX "RecommendationFeedback_organisationId_subjectId_createdAt_idx" ON "RecommendationFeedback"("organisationId", "subjectId", "createdAt");
CREATE INDEX "RecommendationFeedback_organisationId_signal_createdAt_idx" ON "RecommendationFeedback"("organisationId", "signal", "createdAt");

CREATE INDEX "Experiment_organisationId_status_createdAt_idx" ON "Experiment"("organisationId", "status", "createdAt");
CREATE INDEX "Experiment_organisationId_createdAt_idx" ON "Experiment"("organisationId", "createdAt");

CREATE INDEX "AgentVersionCandidate_organisationId_status_createdAt_idx" ON "AgentVersionCandidate"("organisationId", "status", "createdAt");
CREATE INDEX "AgentVersionCandidate_organisationId_agentConfigurationId_idx" ON "AgentVersionCandidate"("organisationId", "agentConfigurationId");

CREATE UNIQUE INDEX "EvalSuite_organisationId_key_key" ON "EvalSuite"("organisationId", "key");
CREATE INDEX "EvalSuite_organisationId_key_idx" ON "EvalSuite"("organisationId", "key");

CREATE INDEX "EvalRun_organisationId_createdAt_idx" ON "EvalRun"("organisationId", "createdAt");
CREATE INDEX "EvalRun_organisationId_suiteKey_createdAt_idx" ON "EvalRun"("organisationId", "suiteKey", "createdAt");
CREATE INDEX "EvalRun_candidateId_idx" ON "EvalRun"("candidateId");

ALTER TABLE "RecommendationFeedback" ADD CONSTRAINT "RecommendationFeedback_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentVersionCandidate" ADD CONSTRAINT "AgentVersionCandidate_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentVersionCandidate" ADD CONSTRAINT "AgentVersionCandidate_agentConfigurationId_fkey" FOREIGN KEY ("agentConfigurationId") REFERENCES "AgentConfiguration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EvalSuite" ADD CONSTRAINT "EvalSuite_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_evalSuiteId_fkey" FOREIGN KEY ("evalSuiteId") REFERENCES "EvalSuite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "AgentVersionCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
