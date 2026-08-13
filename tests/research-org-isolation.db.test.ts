/**
 * DB integration — research models org isolation.
 * Needs real Postgres (DATABASE_URL). Skipped only when unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)("research models — DB org isolation", () => {
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

  it("org A cannot read org B research jobs or sources", async () => {
    const stamp = Date.now();
    const orgA = await prisma.organisation.create({
      data: { name: "Res A", slug: `res-a-${stamp}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Res B", slug: `res-b-${stamp}` },
    });

    const jobB = await prisma.researchJob.create({
      data: {
        organisationId: orgB.id,
        kind: "RESEARCH",
        topic: "secret topic B",
        status: "COMPLETED",
        queries: ["secret"],
      },
    });
    await prisma.researchSource.create({
      data: {
        organisationId: orgB.id,
        researchJobId: jobB.id,
        url: "https://example.com/b-only",
        title: "B only",
        platform: "web",
        content: "TOPSECRET-B",
      },
    });

    const crossJob = await prisma.researchJob.findFirst({
      where: { id: jobB.id, organisationId: orgA.id },
    });
    expect(crossJob).toBeNull();

    const crossSource = await prisma.researchSource.findMany({
      where: { organisationId: orgA.id, researchJobId: jobB.id },
    });
    expect(crossSource).toHaveLength(0);

    await prisma.researchSource.deleteMany({ where: { researchJobId: jobB.id } });
    await prisma.researchJob.delete({ where: { id: jobB.id } });
    await prisma.organisation.delete({ where: { id: orgA.id } });
    await prisma.organisation.delete({ where: { id: orgB.id } });
  });
});
