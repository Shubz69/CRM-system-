-- AlterTable
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "origin" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_organisationId_origin_idx" ON "Message"("organisationId", "origin");
