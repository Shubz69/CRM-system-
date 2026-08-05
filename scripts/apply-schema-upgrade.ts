/**
 * Additive schema upgrade for local/dev databases without force-reset.
 * Run: npx tsx scripts/apply-schema-upgrade.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Prefer UTF-8 for this session
  await prisma.$executeRawUnsafe(`SET client_encoding TO 'UTF8'`);

  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE TYPE "WebhookProcessingStatus_new" AS ENUM ('RECEIVED','PROCESSING','PROCESSED','FAILED','DUPLICATE','IGNORED');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  // ContactIdentifier.organisationId
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "ContactIdentifier" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "ContactIdentifier" ci
    SET "organisationId" = c."organisationId"
    FROM "Contact" c
    WHERE c.id = ci."contactId" AND (ci."organisationId" IS NULL OR ci."organisationId" = '');
  `);
  await prisma.$executeRawUnsafe(`
    DELETE FROM "ContactIdentifier" WHERE "organisationId" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "ContactIdentifier" ALTER COLUMN "organisationId" SET NOT NULL;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "ContactIdentifier" DROP CONSTRAINT IF EXISTS "ContactIdentifier_channel_identifier_key";
  `);
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE "ContactIdentifier" ADD CONSTRAINT "ContactIdentifier_organisationId_channel_identifier_key" UNIQUE ("organisationId", "channel", "identifier");
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  // QualificationField extras
  await prisma.$executeRawUnsafe(`ALTER TABLE "QualificationField" ADD COLUMN IF NOT EXISTS "fieldType" TEXT NOT NULL DEFAULT 'short_text';`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "QualificationField" ADD COLUMN IF NOT EXISTS "options" JSONB NOT NULL DEFAULT '[]';`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "QualificationField" ADD COLUMN IF NOT EXISTS "disqualifyingAnswers" JSONB NOT NULL DEFAULT '[]';`);

  // Attribution.organisationId
  await prisma.$executeRawUnsafe(`ALTER TABLE "Attribution" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;`);
  await prisma.$executeRawUnsafe(`
    UPDATE "Attribution" a
    SET "organisationId" = c."organisationId"
    FROM "Contact" c
    WHERE c.id = a."contactId" AND (a."organisationId" IS NULL OR a."organisationId" = '');
  `);
  await prisma.$executeRawUnsafe(`DELETE FROM "Attribution" WHERE "organisationId" IS NULL;`);
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE "Attribution" ALTER COLUMN "organisationId" SET NOT NULL;
    EXCEPTION WHEN others THEN NULL; END $$;
  `);

  // AgentConfiguration extras
  const agentCols = [
    [`isDraft`, `BOOLEAN NOT NULL DEFAULT false`],
    [`version`, `INTEGER NOT NULL DEFAULT 1`],
    [`publishedVersion`, `INTEGER`],
    [`language`, `TEXT NOT NULL DEFAULT 'en'`],
    [`optOutKeywords`, `JSONB NOT NULL DEFAULT '["stop","unsubscribe","opt out"]'`],
    [`escalationInstructions`, `TEXT`],
    [`lastEditedById`, `TEXT`],
    [`lastPublishedById`, `TEXT`],
    [`publishedAt`, `TIMESTAMP(3)`],
  ] as const;
  for (const [col, def] of agentCols) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "${col}" ${def};`);
  }

  // NotificationType enum values — recreate is hard; store as text already? Prisma uses enum.
  // Add new enum values if using native enum:
  for (const value of ["AI_FAILURE", "FOLLOW_UP_FAILURE", "AUTOMATION_FAILURE", "UNASSIGNED_QUALIFIED"]) {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS '${value}';
      EXCEPTION WHEN others THEN NULL; END $$;
    `);
  }

  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TYPE "WebhookProcessingStatus" ADD VALUE IF NOT EXISTS 'IGNORED';
    EXCEPTION WHEN others THEN NULL; END $$;
  `);

  console.log("Schema upgrade applied.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
