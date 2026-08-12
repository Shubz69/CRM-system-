-- Per-org AI spend cap (pre-dispatch gate). Forward-only migration.

CREATE TABLE "OrganisationAiBudget" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "monthlyCapCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganisationAiBudget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganisationAiBudget_organisationId_key" ON "OrganisationAiBudget"("organisationId");
CREATE INDEX "OrganisationAiBudget_organisationId_idx" ON "OrganisationAiBudget"("organisationId");

ALTER TABLE "OrganisationAiBudget"
  ADD CONSTRAINT "OrganisationAiBudget_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
