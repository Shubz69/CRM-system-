/**
 * DB integration — cross-tenant regressions.
 * Separate file so unit mocks of @/lib/db cannot poison these tests.
 *
 * Skipped only when DATABASE_URL is unset.
 * If DATABASE_URL is set but unreachable, beforeAll fails loudly (not a silent skip).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { cancelPendingFollowUps } from "@/services/followups";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)("org isolation — DB cross-tenant regressions", () => {
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

  it("booking lead updateMany cannot touch another org's lead", async () => {
    const orgA = await prisma.organisation.create({
      data: { name: "Iso A", slug: `iso-a-${Date.now()}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Iso B", slug: `iso-b-${Date.now()}` },
    });
    const contactB = await prisma.contact.create({
      data: { organisationId: orgB.id, fullName: "Victim" },
    });
    const leadB = await prisma.lead.create({
      data: { organisationId: orgB.id, contactId: contactB.id },
    });

    const moved = await prisma.lead.updateMany({
      where: { id: leadB.id, organisationId: orgA.id },
      data: { score: 999 },
    });
    expect(moved.count).toBe(0);

    const unchanged = await prisma.lead.findUnique({ where: { id: leadB.id } });
    expect(unchanged?.score).toBe(0);

    await prisma.lead.delete({ where: { id: leadB.id } });
    await prisma.contact.delete({ where: { id: contactB.id } });
    await prisma.organisation.delete({ where: { id: orgA.id } });
    await prisma.organisation.delete({ where: { id: orgB.id } });
  });

  it("cancelPendingFollowUps with wrong org cancels zero rows", async () => {
    const orgA = await prisma.organisation.create({
      data: { name: "Fu A", slug: `fu-a-${Date.now()}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Fu B", slug: `fu-b-${Date.now()}` },
    });
    const contactB = await prisma.contact.create({
      data: { organisationId: orgB.id, fullName: "B" },
    });
    const conversationB = await prisma.conversation.create({
      data: { organisationId: orgB.id, contactId: contactB.id },
    });
    const followUp = await prisma.followUp.create({
      data: {
        organisationId: orgB.id,
        contactId: contactB.id,
        conversationId: conversationB.id,
        attemptNumber: 1,
        scheduledFor: new Date(Date.now() + 60_000),
        status: "SCHEDULED",
      },
    });

    const cancelled = await cancelPendingFollowUps({
      organisationId: orgA.id,
      conversationId: conversationB.id,
      reason: "cross-org attempt",
    });
    expect(cancelled).toBe(0);

    const still = await prisma.followUp.findUnique({ where: { id: followUp.id } });
    expect(still?.status).toBe("SCHEDULED");

    await prisma.followUp.delete({ where: { id: followUp.id } });
    await prisma.conversation.delete({ where: { id: conversationB.id } });
    await prisma.contact.delete({ where: { id: contactB.id } });
    await prisma.organisation.delete({ where: { id: orgA.id } });
    await prisma.organisation.delete({ where: { id: orgB.id } });
  });
});
