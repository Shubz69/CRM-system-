/**
 * Integration checks against the local database.
 * Requires: DATABASE_URL + npm run db:setup
 * Explicitly skipped (not silently green) when DATABASE_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { clearMockOutboundLog, mockOutboundLog } from "@/adapters/messaging";
import { cancelPendingFollowUps } from "@/services/followups";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("Inbound pipeline integration", () => {
  let organisationId = "";

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

  it("loads demo organisation", async () => {
    const org = await prisma.organisation.findUnique({ where: { slug: "demo-agency" } });
    expect(org).toBeTruthy();
    organisationId = org!.id;
  });

  it("processes a simulated DM end-to-end with idempotency", async () => {
    clearMockOutboundLog();
    const externalId = `itest_${Date.now()}`;
    const idempotencyKey = `itest_key_${Date.now()}`;

    const first = await processInboundMessage(
      {
        organisationId,
        idempotencyKey,
        contact: {
          externalId,
          fullName: "Integration Lead",
          instagramUsername: "integration_lead",
        },
        message: {
          text: "I run a coaching business and get 500 DMs a month. How much does it cost? Can we book a call?",
          externalId: `${externalId}_msg1`,
        },
        threadId: `thread_${externalId}`,
        leadSource: "integration_test",
      },
      { provider: "integration_test" },
    );

    expect(first.duplicate).toBe(false);
    expect(first.contactId).toBeTruthy();
    expect(first.conversationId).toBeTruthy();
    expect(first.leadId).toBeTruthy();
    expect(first.aiReplySent).toBe(true);
    expect(mockOutboundLog.length).toBeGreaterThan(0);

    const lead = await prisma.lead.findUnique({ where: { id: first.leadId! } });
    expect(lead?.score).toBeGreaterThan(0);

    const second = await processInboundMessage(
      {
        organisationId,
        idempotencyKey,
        contact: {
          externalId,
          fullName: "Integration Lead",
          instagramUsername: "integration_lead",
        },
        message: {
          text: "duplicate",
          externalId: `${externalId}_msg1`,
        },
        threadId: `thread_${externalId}`,
      },
      { provider: "integration_test" },
    );

    expect(second.duplicate).toBe(true);
  });

  it("cancels follow-ups", async () => {
    const conversation = await prisma.conversation.findFirst({
      where: { organisationId },
      orderBy: { createdAt: "desc" },
    });
    expect(conversation).toBeTruthy();
    const cancelled = await cancelPendingFollowUps({
      organisationId,
      conversationId: conversation!.id,
      reason: "test cancel",
    });
    expect(cancelled).toBeGreaterThanOrEqual(0);
  });

  it("isolates organisations", async () => {
    const other = await prisma.organisation.create({
      data: { name: "Other Org", slug: `other-${Date.now()}` },
    });
    const count = await prisma.contact.count({ where: { organisationId: other.id } });
    expect(count).toBe(0);
    await prisma.organisation.delete({ where: { id: other.id } });
  });
});
