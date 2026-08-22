-- Phase 8 Automation OS: visible workflows + ApprovalRequest.

ALTER TABLE "AutomationRule"
  ADD COLUMN "workflow" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "naturalLanguageSource" TEXT,
  ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "AutomationExecution"
  ADD COLUMN "organisationId" TEXT,
  ADD COLUMN "workflowSnapshot" JSONB,
  ADD COLUMN "approvalRequestId" TEXT;

CREATE INDEX "AutomationExecution_organisationId_createdAt_idx"
  ON "AutomationExecution"("organisationId", "createdAt");

CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "automationRuleId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApprovalRequest_organisationId_status_createdAt_idx"
  ON "ApprovalRequest"("organisationId", "status", "createdAt");
CREATE INDEX "ApprovalRequest_organisationId_kind_status_idx"
  ON "ApprovalRequest"("organisationId", "kind", "status");
CREATE INDEX "ApprovalRequest_automationRuleId_idx"
  ON "ApprovalRequest"("automationRuleId");

ALTER TABLE "ApprovalRequest"
  ADD CONSTRAINT "ApprovalRequest_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApprovalRequest"
  ADD CONSTRAINT "ApprovalRequest_automationRuleId_fkey"
  FOREIGN KEY ("automationRuleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
