-- Phase 10 — Entitlements + UsageMeter + Organisation.entitlementSnapshot

ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "entitlementSnapshot" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "limitValue" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageMeter" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "meterKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'usage_record',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageMeter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Entitlement_organisationId_capability_key" ON "Entitlement"("organisationId", "capability");
CREATE INDEX "Entitlement_organisationId_enabled_idx" ON "Entitlement"("organisationId", "enabled");

CREATE UNIQUE INDEX "UsageMeter_organisationId_meterKey_periodStart_key" ON "UsageMeter"("organisationId", "meterKey", "periodStart");
CREATE INDEX "UsageMeter_organisationId_periodStart_idx" ON "UsageMeter"("organisationId", "periodStart");

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageMeter" ADD CONSTRAINT "UsageMeter_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
