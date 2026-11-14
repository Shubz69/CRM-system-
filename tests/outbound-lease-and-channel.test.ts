import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingExternalOutcome } from "@prisma/client";

/**
 * - prepareAndSendOutbound forwards expectedActivityVersion (stale AI replies → STALE_CONTEXT)
 * - automated sends wait briefly for a lease held by another dispatch instead of dropping
 * - each dispatch releases only its own lease
 * - Zernio adapter keeps the conversation's account instead of the credential's
 */

const mocks = vi.hoisted(() => ({
  contactFindFirst: vi.fn(),
  conversationFindFirst: vi.fn(),
  isContactSuppressed: vi.fn(),
  outboundDispatchFindUnique: vi.fn(),
  outboundDispatchCreate: vi.fn(),
  outboundDispatchUpdate: vi.fn(),
  outboundDispatchUpdateMany: vi.fn(),
  leaseFindUnique: vi.fn(),
  leaseUpdateMany: vi.fn(),
  leaseCreate: vi.fn(),
  leaseDeleteMany: vi.fn(),
  $transaction: vi.fn(),
  resolveCredential: vi.fn(),
  sendMessage: vi.fn(),
  zernioSend: vi.fn(),
}));

vi.mock("@/services/messaging/suppression", () => ({
  isContactSuppressed: (...args: unknown[]) => mocks.isContactSuppressed(...args),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    contact: { findFirst: mocks.contactFindFirst },
    conversation: { findFirst: mocks.conversationFindFirst },
    outboundDispatch: {
      findUnique: mocks.outboundDispatchFindUnique,
      create: mocks.outboundDispatchCreate,
      update: mocks.outboundDispatchUpdate,
      updateMany: mocks.outboundDispatchUpdateMany,
    },
    conversationSendLease: {
      findUnique: mocks.leaseFindUnique,
      updateMany: mocks.leaseUpdateMany,
      create: mocks.leaseCreate,
      deleteMany: mocks.leaseDeleteMany,
    },
    $transaction: mocks.$transaction,
  },
}));
vi.mock("@/services/messaging/credentials", () => ({
  resolveMessagingSendCredential: (...args: unknown[]) => mocks.resolveCredential(...args),
}));
vi.mock("@/services/domain-events/append", () => ({ appendDomainEvent: vi.fn(async () => ({})) }));
vi.mock("@/adapters/zernio", () => ({ isZernioConfigured: () => true }));
vi.mock("@/adapters/messaging/zernio", () => ({
  createZernioMessagingAdapter: () => ({ name: "zernio", sendMessage: mocks.zernioSend }),
}));

import { prepareAndSendOutbound } from "@/services/messaging/outbound";
import * as messagingAdapters from "@/adapters/messaging";

const openWindow = {
  closedAt: null,
  aiPaused: false,
  handlingMode: "AI",
  lastInboundAt: new Date(),
  messagingWindowExpiresAt: new Date(Date.now() + 60_000),
  humanMessagingWindowExpiresAt: new Date(Date.now() + 60_000),
  metadata: {},
};

function mockConversation(currentVersion: number) {
  mocks.conversationFindFirst.mockImplementation(
    async (args: { select?: Record<string, unknown> }) => {
      if (args.select && "messages" in args.select) {
        return {
          activityVersion: currentVersion,
          metadata: {},
          externalThreadId: "thread-1",
          messages: [{ id: "m-last" }],
        };
      }
      if (args.select && "closedAt" in args.select) return openWindow;
      return { activityVersion: currentVersion };
    },
  );
}

const aiSend = {
  organisationId: "org-1",
  conversationId: "conv-1",
  contactId: "contact-1",
  contactExternalId: "ig-1",
  text: "Hello",
  source: "AI" as const,
  holder: "ai:conv-1:in-msg-1",
  idempotencyKey: "ai-reply:in-msg-1",
  provider: "manychat",
  channel: "manychat",
};

describe("outbound lease + activity version", () => {
  let adapterSpy: { mockRestore: () => void } | null = null;

  afterEach(() => {
    adapterSpy?.mockRestore();
    adapterSpy = null;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_AUTO_SOCIAL_SEND = "true";
    mocks.contactFindFirst.mockResolvedValue({ optedOut: false, metadata: {} });
    mocks.isContactSuppressed.mockResolvedValue(false);
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: null,
    });
    mocks.outboundDispatchUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: "dispatch-1",
      ...args.data,
    }));
    mocks.outboundDispatchUpdateMany.mockResolvedValue({ count: 0 });
    mocks.leaseFindUnique.mockResolvedValue(null);
    mocks.leaseCreate.mockResolvedValue({});
    mocks.leaseDeleteMany.mockResolvedValue({ count: 1 });
    mocks.resolveCredential.mockResolvedValue({ token: "tok", source: "organisation", connectionRef: null });
    mocks.sendMessage.mockResolvedValue({ ok: true, provider: "manychat", externalMessageId: "ext-1" });
    mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        message: { create: vi.fn(async () => ({ id: "msg-out-1" })) },
        conversation: { update: vi.fn(async () => ({})) },
        outboundDispatch: {
          update: vi.fn(async () => ({
            id: "dispatch-1",
            messageId: "msg-out-1",
            externalOutcome: MessagingExternalOutcome.CONFIRMED,
          })),
        },
      }),
    );
    adapterSpy = vi
      .spyOn(messagingAdapters, "getMessagingAdapterForOrganisation")
      .mockResolvedValue({ name: "manychat", sendMessage: mocks.sendMessage });
  });

  it("forwards expectedActivityVersion: a reply drafted before a newer DM is STALE_CONTEXT", async () => {
    mockConversation(8); // a newer inbound bumped the version during the AI call

    const result = await prepareAndSendOutbound({ ...aiSend, expectedActivityVersion: 7 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("STALE_CONTEXT");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.outboundDispatchCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expectedActivityVersion: 7 }) }),
    );
  });

  it("sends when the conversation has not moved since the inbound", async () => {
    mockConversation(7);

    const result = await prepareAndSendOutbound({ ...aiSend, expectedActivityVersion: 7 });

    expect(result.ok).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    // Only this dispatch's lease is released.
    expect(mocks.leaseDeleteMany).toHaveBeenCalledWith({
      where: { conversationId: "conv-1", holder: "ai:conv-1:in-msg-1" },
    });
  });

  it("waits for a lease another automated dispatch holds, then sends", async () => {
    mockConversation(7);
    mocks.leaseFindUnique.mockResolvedValue({ holder: "ai:conv-1:in-msg-0" });
    mocks.leaseUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });

    const result = await prepareAndSendOutbound({ ...aiSend, expectedActivityVersion: 7 });

    expect(result.ok).toBe(true);
    expect(mocks.leaseUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.leaseUpdateMany.mock.calls[0]![0]).toMatchObject({
      where: { OR: [{ holder: "ai:conv-1:in-msg-1" }, expect.anything()] },
    });
  });

  it("gives up with LEASE_UNAVAILABLE if the other dispatch keeps the lease", async () => {
    mockConversation(7);
    mocks.leaseFindUnique.mockResolvedValue({ holder: "ai:conv-1:in-msg-0" });
    mocks.leaseUpdateMany.mockResolvedValue({ count: 0 });

    const result = await prepareAndSendOutbound({ ...aiSend, expectedActivityVersion: 7 });

    expect(result.code).toBe("LEASE_UNAVAILABLE");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.leaseUpdateMany.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("Zernio adapter account selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCredential.mockResolvedValue({
      token: "zernio-token",
      source: "organisation",
      connectionRef: "zernio:profile-1",
      igUserId: "credential-account",
    });
    mocks.zernioSend.mockResolvedValue({ ok: true, provider: "zernio" });
  });

  it("keeps the conversation's own Zernio account", async () => {
    const adapter = await messagingAdapters.getMessagingAdapterForOrganisation("org-1", true, "zernio");
    await adapter.sendMessage({
      organisationId: "org-1",
      contactExternalId: "ig-1",
      text: "hi",
      metadata: { zernioAccountId: "conversation-account" },
    });

    expect(mocks.zernioSend).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ zernioAccountId: "conversation-account" }),
      }),
    );
  });

  it("falls back to the credential's account when the message has none", async () => {
    const adapter = await messagingAdapters.getMessagingAdapterForOrganisation("org-1", true, "zernio");
    await adapter.sendMessage({ organisationId: "org-1", contactExternalId: "ig-1", text: "hi" });

    expect(mocks.zernioSend).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ zernioAccountId: "credential-account" }),
      }),
    );
  });
});
