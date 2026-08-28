/**
 * Needs real Postgres (DATABASE_URL). Kept separate from unit mocks in ai-spend-gate.test.ts.
 */
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { assertWithinSpendCap, setOrganisationAiBudget } from "@/services/ai-spend-gate";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("AI spend gate — DB cross-org (needs Postgres)", () => {
  it("budget rows are org-scoped; other org cap does not apply", async () => {
    const orgA = await prisma.organisation.create({
      data: { name: "Spend A", slug: `spend-a-${Date.now()}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Spend B", slug: `spend-b-${Date.now()}` },
    });

    try {
      await setOrganisationAiBudget({ organisationId: orgA.id, monthlyCapCents: 1 });
      await expect(assertWithinSpendCap(orgB.id)).resolves.toMatchObject({
        ok: true,
        capCents: null,
      });
    } finally {
      await prisma.organisationAiBudget.deleteMany({ where: { organisationId: orgA.id } });
      await prisma.organisation.delete({ where: { id: orgA.id } });
      await prisma.organisation.delete({ where: { id: orgB.id } });
    }
  });
});
