-- Native Meta Instagram messaging provider + OAuth state single-use ledger

DO $$ BEGIN
  ALTER TYPE "IntegrationType" ADD VALUE IF NOT EXISTS 'META_INSTAGRAM';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "OAuthStateConsumption" (
  "nonce" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "userId" TEXT,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OAuthStateConsumption_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX IF NOT EXISTS "OAuthStateConsumption_organisationId_purpose_idx"
  ON "OAuthStateConsumption"("organisationId", "purpose");
CREATE INDEX IF NOT EXISTS "OAuthStateConsumption_expiresAt_idx"
  ON "OAuthStateConsumption"("expiresAt");
