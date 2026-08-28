-- Phase 11 - credential health / rotation metadata (additive; does not rotate ciphertext)

ALTER TABLE "IntegrationCredential" ADD COLUMN IF NOT EXISTS "healthStatus" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "IntegrationCredential" ADD COLUMN IF NOT EXISTS "healthNote" TEXT;
ALTER TABLE "IntegrationCredential" ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMP(3);
ALTER TABLE "IntegrationCredential" ADD COLUMN IF NOT EXISTS "lastRotatedAt" TIMESTAMP(3);

ALTER TABLE "SocialConnectionCredential" ADD COLUMN IF NOT EXISTS "healthStatus" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "SocialConnectionCredential" ADD COLUMN IF NOT EXISTS "healthNote" TEXT;
ALTER TABLE "SocialConnectionCredential" ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMP(3);
ALTER TABLE "SocialConnectionCredential" ADD COLUMN IF NOT EXISTS "lastRotatedAt" TIMESTAMP(3);
