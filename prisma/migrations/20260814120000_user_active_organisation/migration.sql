-- AlterTable
ALTER TABLE "User" ADD COLUMN "activeOrganisationId" TEXT;

-- CreateIndex
CREATE INDEX "User_activeOrganisationId_idx" ON "User"("activeOrganisationId");
