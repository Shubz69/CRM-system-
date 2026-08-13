/**
 * DB integration — Apify AiExecution spend is org-scoped.
 * Needs real Postgres (DATABASE_URL). Skipped only when unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { recordApifySpend } from "@/adapters/sources/apify-billing";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)("Apify spend recording — DB org isolation", () => {
  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DATABASE_URL is set but Postgres is unreachable — refusing to skip. ${message}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("org A cannot see org B Apify AiExecution rows", async () => {
    const stamp = Date.now();
    const orgA = await prisma.organisation.create({
      data: { name: "Apify A", slug: `apify-a-${stamp}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Apify B", slug: `apify-b-${stamp}` },
    });

    await recordApifySpend({
      organisationId: orgB.id,
      platform: "instagram",
      costCents: 5,
      success: true,
      metadata: { actorId: "apify/instagram-scraper", runId: `run-${stamp}` },
    });

    const cross = await prisma.aiExecution.findFirst({
      where: {
        organisationId: orgA.id,
        provider: "apify",
        feature: "source:instagram",
      },
    });
    expect(cross).toBeNull();

    const same = await prisma.aiExecution.findFirst({
      where: {
        organisationId: orgB.id,
        provider: "apify",
        feature: "source:instagram",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(same?.estimatedCost).toBeCloseTo(0.05, 5);

    await prisma.aiExecution.deleteMany({
      where: { organisationId: { in: [orgA.id, orgB.id] } },
    });
    await prisma.usageRecord.deleteMany({
      where: { organisationId: { in: [orgA.id, orgB.id] } },
    });
    await prisma.organisation.delete({ where: { id: orgA.id } });
    await prisma.organisation.delete({ where: { id: orgB.id } });
  });
});
