import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Unit coverage for processInboundMessage hardening (no database):
 * - P2002 inside the inbound transaction retries the whole transaction
 * - soft-deleted contacts found by identifier are restored
 * - AI reply carries the inbound activity version + a per-message lease holder
 * - booking offer / booking_link_sent / follow-ups only after an actual send
 */

const mocks = vi.hoisted(() => ({
  webhookEventFindUnique: vi.fn(),
  webhookEventCreate: vi.fn(),
  webhookEventUpdate: vi.fn(),
  organisationFindFirst: vi.fn(),
  organisationUpdateMany: vi.fn(),
  pipelineFindFirst: vi.fn(),
  agentConfigurationFindFirst: vi.fn(),
  messageFindMany: vi.fn(),
  messageUpdate: vi.fn(),
  conversationUpdate: vi.fn(),
  conversationFindUnique: vi.fn(async () => ({ activityVersion: 7 })),
  bookingFindFirst: vi.fn(),
  bookingCreate: vi.fn(),
  knowledgeRecommendationCreate: vi.fn(),
  $transaction: vi.fn(),
  runAutomations: vi.fn(),
  routeAndAnalyse: vi.fn(),
  prepareAndSendOutbound: vi.fn(),
  createAiOutboundApprovalRequest: vi.fn(),
  isAiAutoSocialSendEnabled: vi.fn(),
  scheduleFollowUps: vi.fn(),
  cancelPendingFollowUps: vi.fn(),
  appendDomainEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhookEvent: {
      findUnique: mocks.webhookEventFindUnique,
      create: mocks.webhookEventCreate,
      update: mocks.webhookEventUpdate,
    },
    organisation: {
      findFirst: mocks.organisationFindFirst,
      updateMany: mocks.organisationUpdateMany,
    },
    pipeline: { findFirst: mocks.pipelineFindFirst },
    agentConfiguration: { findFirst: mocks.agentConfigurationFindFirst },
    message: { findMany: mocks.messageFindMany, update: mocks.messageUpdate },
    conversation: { update: mocks.conversationUpdate, findUnique: mocks.conversationFindUnique },
    booking: { findFirst: mocks.bookingFindFirst, create: mocks.bookingCreate },
    knowledgeRecommendation: { create: mocks.knowledgeRecommendationCreate },
    $transaction: mocks.$transaction,
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/adapters/ai", () => ({ buildAgentSystemPrompt: () => "system" }));
vi.mock("@/adapters/booking", () => ({
  getBookingProvider: () => ({
    createBookingLink: async () => ({ url: "https://book.test/slot", provider: "link" }),
  }),
}));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/services/attribution", () => ({ upsertCampaignAttribution: vi.fn() }));
vi.mock("@/services/automations", () => ({
  runAutomations: (...args: unknown[]) => mocks.runAutomations(...args),
}));
vi.mock("@/services/ai-router", () => ({
  routeAndAnalyse: (...args: unknown[]) => mocks.routeAndAnalyse(...args),
}));
vi.mock("@/services/followups", () => ({
  cancelFollowUpsOnOptOut: vi.fn(),
  cancelPendingFollowUps: (...args: unknown[]) => mocks.cancelPendingFollowUps(...args),
  scheduleFollowUps: (...args: unknown[]) => mocks.scheduleFollowUps(...args),
}));
vi.mock("@/services/knowledge", () => ({
  retrieveRelevantKnowledge: async () => ({ chunks: ["pricing"], documentTitles: ["Prices"] }),
}));
vi.mock("@/services/notifications", () => ({
  notifyOnHandover: vi.fn(),
  notifyOnHighScore: vi.fn(),
  notifyOnNegativeSentiment: vi.fn(),
  notifyOrganisationOwners: vi.fn(),
}));
vi.mock("@/services/qualification", () => ({ syncQualificationAnswers: vi.fn() }));
vi.mock("@/services/scoring", () => ({
  calculateLeadScore: () => ({ totalScore: 40, explanation: "ok", components: [] }),
}));
vi.mock("@/services/usage", () => ({ recordUsage: vi.fn() }));
vi.mock("@/services/intelligence-flags", () => ({ isIntelligenceFlagEnabled: async () => false }));
vi.mock("@/services/messaging/nba", () => ({ decideNextBestAction: vi.fn() }));
vi.mock("@/services/messaging/objections", () => ({ recordObjection: vi.fn() }));
vi.mock("@/services/messaging/outbound", () => ({
  prepareAndSendOutbound: (...args: unknown[]) => mocks.prepareAndSendOutbound(...args),
}));
vi.mock("@/services/automation-os", () => ({
  createAiOutboundApprovalRequest: (...args: unknown[]) =>
    mocks.createAiOutboundApprovalRequest(...args),
}));
vi.mock("@/lib/ai-auto-social-send", () => ({
  isAiAutoSocialSendEnabled: () => mocks.isAiAutoSocialSendEnabled(),
}));
vi.mock("@/services/messaging/understanding", () => ({
  classifyInboundL0: () => ({
    level: "L0",
    intent: "GENERAL",
    meetingIntent: false,
    objectionCategory: null,
    optedOut: false,
    confidenceBand: "MEDIUM",
    matchedKeywords: [],
  }),
  persistUnderstanding: vi.fn(),
  runUnderstandingShadow: vi.fn(),
}));
vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: (...args: unknown[]) => mocks.appendDomainEvent(...args),
}));

import { processInboundMessage } from "@/services/inbound-pipeline";

const ORG = "org-1";

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    intent: "pricing",
    sentiment: "positive",
    conversation_summary: "Lead asked to book",
    qualification_score: 60,
    qualification_status: "qualifying",
    qualification_reasons: [],
    answers_collected: {},
    missing_qualification_fields: [],
    questions_detected: [],
    objections_detected: [],
    buying_signals: [],
    recommended_next_action: "send_booking_link",
    should_handover: false,
    handover_reason: null,
    confidence: 0.9,
    reply: "Happy to help!",
    ...overrides,
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "conv-1",
    contactId: "contact-1",
    externalThreadId: "thread-1",
    activityVersion: 7,
    aiPaused: false,
    handlingMode: "AI",
    metadata: {},
    lastInboundAt: new Date(now),
    messagingWindowExpiresAt: new Date(now + 60 * 60_000),
    humanMessagingWindowExpiresAt: new Date(now + 7 * 24 * 60 * 60_000),
    ...overrides,
  };
}

type Tx = ReturnType<typeof makeTx>;

function makeTx(opts: { identifierContact?: Record<string, unknown> | null } = {}) {
  const contact = opts.identifierContact ?? null;
  return {
    messagingChannel: {
      findFirst: vi.fn(async () => ({ id: "ch-1", instagramUsername: "brand" })),
      create: vi.fn(),
      update: vi.fn(),
    },
    contactIdentifier: {
      findUnique: vi.fn(async () => (contact ? { id: "ident-1", contact } : null)),
      create: vi.fn(async () => ({ id: "ident-1" })),
    },
    contact: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({
        id: "contact-1",
        optedOut: false,
        deletedAt: null,
        metadata: {},
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        ...(contact ?? {}),
        ...args.data,
        id: "contact-1",
        optedOut: false,
      })),
    },
    conversation: {
      findFirst: vi.fn(async () => conversationRow({ activityVersion: 6 })),
      create: vi.fn(async () => conversationRow()),
      update: vi.fn(async () => conversationRow()),
    },
    message: {
      upsert: vi.fn(async () => ({ id: "in-msg-1" })),
      findUnique: vi.fn(async () => null),
    },
    lead: {
      findFirst: vi.fn(async () => ({
        id: "lead-1",
        stageId: null,
        score: 0,
        metadata: {},
        qualificationStatus: "UNKNOWN",
      })),
      findUnique: vi.fn(async () => ({
        stageId: null,
        score: 0,
        metadata: {},
        qualificationStatus: "UNKNOWN",
      })),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    leadScore: { create: vi.fn(async () => ({})) },
    leadScoreEvent: { create: vi.fn(async () => ({})) },
    objection: { create: vi.fn() },
    detectedQuestion: { create: vi.fn() },
    knowledgeRecommendation: { create: vi.fn() },
    buyingSignal: { create: vi.fn() },
  };
}

function useTx(tx: Tx) {
  mocks.$transaction.mockImplementation(async (fn: (client: Tx) => Promise<unknown>) => fn(tx));
}

const input = {
  organisationId: ORG,
  idempotencyKey: "evt-1",
  contact: { externalId: "ig-user-1" },
  message: { text: "Can I book a call?", externalId: "mid-1" },
  threadId: "thread-1",
};

describe("processInboundMessage hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.webhookEventFindUnique.mockResolvedValue(null);
    mocks.webhookEventCreate.mockResolvedValue({ id: "wh-1" });
    mocks.webhookEventUpdate.mockResolvedValue({});
    mocks.organisationFindFirst.mockResolvedValue({
      id: ORG,
      status: "ACTIVE",
      autopilotMode: "LIVE",
      autopilotConfig: { aiResponses: "automatic", booking: "automatic" },
    });
    mocks.organisationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.pipelineFindFirst.mockResolvedValue(null);
    mocks.agentConfigurationFindFirst.mockResolvedValue({
      bookingUrl: "https://book.test/slot",
      confidenceThreshold: 0.5,
      followUpDelaysMinutes: [60],
      maxFollowUps: 1,
    });
    mocks.messageFindMany.mockResolvedValue([]);
    mocks.messageUpdate.mockResolvedValue({});
    mocks.conversationUpdate.mockResolvedValue({});
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.bookingCreate.mockResolvedValue({ id: "booking-1" });
    mocks.runAutomations.mockResolvedValue(0);
    mocks.routeAndAnalyse.mockResolvedValue({
      result: { ok: true, analysis: analysis(), repaired: false },
      provider: "anthropic",
      model: "model-x",
      tier: "default",
      taskType: "conversation",
      latencyMs: 5,
    });
    mocks.isAiAutoSocialSendEnabled.mockReturnValue(true);
    mocks.prepareAndSendOutbound.mockResolvedValue({
      ok: true,
      code: "CONFIRMED",
      dispatch: { id: "dispatch-1", messageId: "out-1", externalOutcome: "CONFIRMED" },
    });
    mocks.createAiOutboundApprovalRequest.mockResolvedValue({ id: "approval-1" });
    mocks.scheduleFollowUps.mockResolvedValue(undefined);
    mocks.cancelPendingFollowUps.mockResolvedValue(undefined);
    mocks.appendDomainEvent.mockResolvedValue({});
  });

  it("retries the whole inbound transaction once a concurrent insert raises P2002", async () => {
    const tx = makeTx();
    let attempts = 0;
    mocks.$transaction.mockImplementation(async (fn: (client: Tx) => Promise<unknown>) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6.0.0",
          meta: { target: ["organisationId", "channel", "identifier"] },
        });
      }
      return fn(tx);
    });

    const result = await processInboundMessage(input, { provider: "zernio" });

    expect(result.conversationId).toBe("conv-1");
    expect(result.aiReplySent).toBe(true);
    // 1 failed inbound attempt + 1 retried inbound + 1 analysis write transaction
    expect(attempts).toBe(3);
  });

  it("does not retry non-unique errors and marks the event FAILED", async () => {
    mocks.$transaction.mockRejectedValue(new Error("connection reset"));

    await expect(processInboundMessage(input, { provider: "zernio" })).rejects.toThrow(
      "connection reset",
    );
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.webhookEventUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("gives up after repeated unique conflicts", async () => {
    mocks.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.0.0",
      }),
    );
    await expect(processInboundMessage(input, { provider: "zernio" })).rejects.toThrow();
    expect(mocks.$transaction).toHaveBeenCalledTimes(3);
  });

  it("restores a soft-deleted contact found by its identifier", async () => {
    const tx = makeTx({
      identifierContact: {
        id: "contact-1",
        fullName: "Lead",
        instagramUsername: null,
        email: null,
        phone: null,
        campaignSource: null,
        optedOut: false,
        deletedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    useTx(tx);

    await processInboundMessage(input, { provider: "zernio" });

    expect(tx.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: null }) }),
    );
  });

  it("does not touch deletedAt for a live contact", async () => {
    const tx = makeTx({
      identifierContact: { id: "contact-1", fullName: "Lead", optedOut: false, deletedAt: null },
    });
    useTx(tx);

    await processInboundMessage(input, { provider: "zernio" });

    const data = tx.contact.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect("deletedAt" in data).toBe(false);
  });

  it("sends the AI reply with the inbound activity version and a per-message lease holder", async () => {
    useTx(makeTx());

    await processInboundMessage(input, { provider: "zernio" });

    expect(mocks.prepareAndSendOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedActivityVersion: 7,
        holder: "ai:conv-1:in-msg-1",
        idempotencyKey: "ai-reply:in-msg-1",
        provider: "zernio",
      }),
    );
  });

  it("records the booking offer, fires booking_link_sent and schedules follow-ups only after a send", async () => {
    useTx(makeTx());

    await processInboundMessage(input, { provider: "zernio" });

    expect(mocks.bookingCreate).toHaveBeenCalledTimes(1);
    expect(mocks.bookingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "OFFERED", leadId: "lead-1" }),
      }),
    );
    expect(mocks.runAutomations).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "booking_link_sent" }),
    );
    expect(mocks.scheduleFollowUps).toHaveBeenCalledTimes(1);
    // The offer is recorded after the reply went out, not before.
    expect(mocks.prepareAndSendOutbound.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bookingCreate.mock.invocationCallOrder[0]!,
    );
  });

  it("does not create a second OFFERED booking when the lead already has one", async () => {
    useTx(makeTx());
    mocks.bookingFindFirst.mockResolvedValue({ id: "booking-existing" });

    await processInboundMessage(input, { provider: "zernio" });

    expect(mocks.bookingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leadId: "lead-1", status: "OFFERED" }),
      }),
    );
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
  });

  it("draft pending approval: no offer, no booking_link_sent, no follow-ups", async () => {
    useTx(makeTx());
    mocks.isAiAutoSocialSendEnabled.mockReturnValue(false);

    const result = await processInboundMessage(input, { provider: "zernio" });

    expect(result.aiReplySent).toBe(false);
    expect(mocks.createAiOutboundApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ holder: "ai:conv-1:in-msg-1" }),
      }),
    );
    expect(mocks.prepareAndSendOutbound).not.toHaveBeenCalled();
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.runAutomations).not.toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "booking_link_sent" }),
    );
    expect(mocks.scheduleFollowUps).not.toHaveBeenCalled();
  });

  it("failed send: no offer, no booking_link_sent, no follow-ups", async () => {
    useTx(makeTx());
    mocks.prepareAndSendOutbound.mockResolvedValue({ ok: false, code: "PROVIDER_SEND_FAILED" });

    const result = await processInboundMessage(input, { provider: "zernio" });

    expect(result.aiReplySent).toBe(false);
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.runAutomations).not.toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "booking_link_sent" }),
    );
    expect(mocks.scheduleFollowUps).not.toHaveBeenCalled();
  });
});
