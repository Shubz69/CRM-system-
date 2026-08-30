-- Launch closure: workspace onboarding invitations + agent answer modes

DO $$ BEGIN
  CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AgentAnswerMode" AS ENUM ('QUICK', 'EXECUTIVE', 'ACTION', 'DEEP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "OrganisationInvitation" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "MemberRole" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "invitedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "OrganisationInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrganisationInvitation_tokenHash_key" ON "OrganisationInvitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "OrganisationInvitation_organisationId_email_status_idx" ON "OrganisationInvitation"("organisationId", "email", "status");
CREATE INDEX IF NOT EXISTS "OrganisationInvitation_organisationId_status_idx" ON "OrganisationInvitation"("organisationId", "status");
CREATE INDEX IF NOT EXISTS "OrganisationInvitation_email_idx" ON "OrganisationInvitation"("email");

DO $$ BEGIN
  ALTER TABLE "OrganisationInvitation"
    ADD CONSTRAINT "OrganisationInvitation_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "OrganisationInvitation"
    ADD CONSTRAINT "OrganisationInvitation_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "answerMode" "AgentAnswerMode";
