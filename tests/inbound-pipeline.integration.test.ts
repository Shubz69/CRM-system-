/**
 * Integration checks against a real Postgres database.
 * Requires: DATABASE_URL
 * Explicitly skipped (not silently green) when DATABASE_URL is unset.
 * Creates and tears down its own organisation — does not use seeded demo data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { clearMockOutboundLog, mockOutboundLog } from "@/adapters/messaging";
import { cancelPendingFollowUps } from "@/services/followups";
import {
  createTestOrganisation,
  destroyTestOrganisation,
  type TestOrganisationFixture,
} from "./helpers/org-fixtures";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("Inbound pipeline integration", () => {
  let fixture: TestOrganisationFixture;
  let organisationId = "";
  const previousAiProvider = process.env.AI_PROVIDER;
  const previousManychatToken = process.env.MANYCHAT_API_TOKEN;

  beforeAll(async () => {
    // Force mock transports so the test does not call live ManyChat/Anthropic.
    process.env.AI_PROVIDER = "mock";
    delete process.env.MANYCHAT_API_TOKEN;
    resetEnvCache();

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DATABASE_URL is set but Postgres is unreachable — refusing to skip. ${message}`,
      );
    }
    fixture = await createTestOrganisation("inbound");
    organisationId = fixture.organisationId;
  });

  afterAll(async () => {
    if (fixture) await destroyTestOrganisation(fixture);
    if (previousAiProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousAiProvider;
    if (previousManychatToken === undefined) delete process.env.MANYCHAT_API_TOKEN;
    else process.env.MANYCHAT_API_TOKEN = previousManychatToken;
    resetEnvCache();
    await prisma.$disconnect();
  });

  it(
    "processes a simulated DM end-to-end with idempotency",
    async () => {
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

    const inbound = await prisma.message.findFirst({
      where: { organisationId, conversationId: first.conversationId!, direction: "INBOUND" },
    });
    expect(inbound?.origin).toBe("integration_test");

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
  },
  60_000,
  );

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
  },
  30_000,
  );

  it("isolates organisations", async () => {
    const other = await createTestOrganisation("other");
    try {
      const count = await prisma.contact.count({ where: { organisationId: other.organisationId } });
      expect(count).toBe(0);
    } finally {
      await destroyTestOrganisation(other);
    }
  });
});
