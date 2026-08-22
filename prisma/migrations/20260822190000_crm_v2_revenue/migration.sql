-- Phase 7 Universal CRM + Revenue.

ALTER TABLE "Organisation"
  ADD COLUMN "industryTemplateKey" TEXT,
  ADD COLUMN "industryTemplateConfig" JSONB NOT NULL DEFAULT '{}';

CREATE TYPE "DealStatus" AS ENUM ('OPEN', 'WON', 'LOST', 'ABANDONED');

CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "sizeBand" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Company_organisationId_name_key" ON "Company"("organisationId", "name");
CREATE INDEX "Company_organisationId_domain_idx" ON "Company"("organisationId", "domain");
CREATE INDEX "Company_organisationId_updatedAt_idx" ON "Company"("organisationId", "updatedAt");

ALTER TABLE "Company"
  ADD CONSTRAINT "Company_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "companyId" TEXT,
    "contactId" TEXT,
    "leadId" TEXT,
    "name" TEXT NOT NULL,
    "amountCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "DealStatus" NOT NULL DEFAULT 'OPEN',
    "probability" DOUBLE PRECISION,
    "stageLabel" TEXT,
    "expectedCloseAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "summary" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Deal_organisationId_status_updatedAt_idx" ON "Deal"("organisationId", "status", "updatedAt");
CREATE INDEX "Deal_organisationId_companyId_idx" ON "Deal"("organisationId", "companyId");
CREATE INDEX "Deal_organisationId_contactId_idx" ON "Deal"("organisationId", "contactId");
CREATE INDEX "Deal_organisationId_leadId_idx" ON "Deal"("organisationId", "leadId");

ALTER TABLE "Deal"
  ADD CONSTRAINT "Deal_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Deal"
  ADD CONSTRAINT "Deal_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "leadId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmActivity_organisationId_createdAt_idx" ON "CrmActivity"("organisationId", "createdAt");
CREATE INDEX "CrmActivity_organisationId_contactId_createdAt_idx" ON "CrmActivity"("organisationId", "contactId", "createdAt");
CREATE INDEX "CrmActivity_organisationId_dealId_createdAt_idx" ON "CrmActivity"("organisationId", "dealId", "createdAt");
CREATE INDEX "CrmActivity_organisationId_dueAt_idx" ON "CrmActivity"("organisationId", "dueAt");

ALTER TABLE "CrmActivity"
  ADD CONSTRAINT "CrmActivity_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Contact" ADD COLUMN "companyId" TEXT;
CREATE INDEX "Contact_organisationId_companyId_idx" ON "Contact"("organisationId", "companyId");

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Deal"
  ADD CONSTRAINT "Deal_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Deal"
  ADD CONSTRAINT "Deal_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmActivity"
  ADD CONSTRAINT "CrmActivity_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmActivity"
  ADD CONSTRAINT "CrmActivity_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmActivity"
  ADD CONSTRAINT "CrmActivity_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmActivity"
  ADD CONSTRAINT "CrmActivity_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Attribution"
  ADD COLUMN "dealId" TEXT,
  ADD COLUMN "confidence" DOUBLE PRECISION,
  ADD COLUMN "limitations" TEXT,
  ADD COLUMN "method" TEXT;

CREATE INDEX "Attribution_organisationId_dealId_idx" ON "Attribution"("organisationId", "dealId");

ALTER TABLE "Attribution"
  ADD CONSTRAINT "Attribution_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
