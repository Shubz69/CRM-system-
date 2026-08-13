/**
 * DB integration — Asset org isolation.
 * Needs real Postgres (DATABASE_URL). Skipped only when unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)("Asset model — DB org isolation", () => {
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

  it("org A cannot read org B assets by id", async () => {
    const stamp = Date.now();
    const orgA = await prisma.organisation.create({
      data: { name: "Asset A", slug: `asset-a-${stamp}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Asset B", slug: `asset-b-${stamp}` },
    });

    const assetB = await prisma.asset.create({
      data: {
        organisationId: orgB.id,
        url: "https://example.com/b.png",
        storageKey: `org/${orgB.id}/reference/secret.png`,
        mimeType: "image/png",
        kind: "reference",
        prompt: "secret-b",
      },
    });

    const cross = await prisma.asset.findFirst({
      where: { id: assetB.id, organisationId: orgA.id },
    });
    expect(cross).toBeNull();

    const sameOrg = await prisma.asset.findFirst({
      where: { id: assetB.id, organisationId: orgB.id },
    });
    expect(sameOrg?.prompt).toBe("secret-b");

    await prisma.asset.delete({ where: { id: assetB.id } });
    await prisma.organisation.delete({ where: { id: orgA.id } });
    await prisma.organisation.delete({ where: { id: orgB.id } });
  });

  it("AgentRun referenceAssetId stays org-scoped via Asset lookup pattern", async () => {
    const stamp = Date.now();
    const orgA = await prisma.organisation.create({
      data: { name: "Run A", slug: `run-a-${stamp}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Run B", slug: `run-b-${stamp}` },
    });
    const assetB = await prisma.asset.create({
      data: {
        organisationId: orgB.id,
        url: "https://example.com/ref.png",
        storageKey: `org/${orgB.id}/reference/ref.png`,
        mimeType: "image/png",
        kind: "reference",
      },
    });

    const stolen = await prisma.asset.findFirst({
      where: { id: assetB.id, organisationId: orgA.id },
    });
    expect(stolen).toBeNull();

    await prisma.asset.delete({ where: { id: assetB.id } });
    await prisma.organisation.delete({ where: { id: orgA.id } });
    await prisma.organisation.delete({ where: { id: orgB.id } });
  });
});
