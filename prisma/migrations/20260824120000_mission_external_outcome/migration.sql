-- Phase 12 acceptance: consequential outcome + approval audit fields

CREATE TYPE "MissionExternalOutcome" AS ENUM (
  'NOT_STARTED',
  'DISPATCHING',
  'CONFIRMED',
  'FAILED',
  'RECONCILIATION_REQUIRED'
);

ALTER TABLE "MissionTask" ADD COLUMN "externalOutcome" "MissionExternalOutcome" NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "MissionTask" ADD COLUMN "approvalUserId" TEXT;
ALTER TABLE "MissionTask" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "MissionTask" ADD COLUMN "rejectedAt" TIMESTAMP(3);
ALTER TABLE "MissionTask" ADD COLUMN "rejectionReason" TEXT;

CREATE INDEX "MissionTask_organisationId_externalOutcome_idx" ON "MissionTask"("organisationId", "externalOutcome");
