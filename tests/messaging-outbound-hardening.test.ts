import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingExternalOutcome } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  contactFindFirst: vi.fn(),
  conversationFindFirst: vi.fn(),
  isContactSuppressed: vi.fn(),
  outboundDispatchFindUnique: vi.fn(),
  outboundDispatchCreate: vi.fn(),
  outboundDispatchUpdate: vi.fn(),
  outboundDispatchUpdateMany: vi.fn(),
  conversationSendLeaseFindUnique: vi.fn(),
  conversationSendLeaseUpdateMany: vi.fn(),
  conversationSendLeaseCreate: vi.fn(),
  conversationSendLeaseDeleteMany: vi.fn(),
  $transaction: vi.fn(),
  resolveCredential: vi.fn(),
  sendMessage: vi.fn(),
  appendDomainEvent: vi.fn(),
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
      findUnique: mocks.conversationSendLeaseFindUnique,
      updateMany: mocks.conversationSendLeaseUpdateMany,
      create: mocks.conversationSendLeaseCreate,
      deleteMany: mocks.conversationSendLeaseDeleteMany,
    },
    $transaction: mocks.$transaction,
  },
}));

vi.mock("@/services/messaging/credentials", () => ({
  resolveMessagingSendCredential: (...args: unknown[]) =>
    mocks.resolveCredential(...args),
}));

vi.mock("@/adapters/messaging", () => ({
  getMessagingAdapterForOrganisation: vi.fn(async () => ({
    name: "manychat",
    sendMessage: mocks.sendMessage,
  })),
}));

vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: (...args: unknown[]) => mocks.appendDomainEvent(...args),
}));

import { dispatchOutboundMessage } from "@/services/messaging/outbound";

const openWindow = {
  closedAt: null,
  aiPaused: false,
  handlingMode: "AI",
  lastInboundAt: new Date(),
  messagingWindowExpiresAt: new Date(Date.now() + 60_000),
  humanMessagingWindowExpiresAt: new Date(Date.now() + 60_000),
  metadata: {},
};

function mockContactableOk() {
  mocks.contactFindFirst.mockResolvedValue({ optedOut: false, metadata: {} });
  mocks.isContactSuppressed.mockResolvedValue(false);
}

function mockLeaseOk() {
  mocks.conversationSendLeaseFindUnique.mockResolvedValue(null);
  mocks.conversationSendLeaseCreate.mockResolvedValue({});
  mocks.conversationSendLeaseDeleteMany.mockResolvedValue({ count: 1 });
  mocks.outboundDispatchUpdateMany.mockResolvedValue({ count: 0 });
}

describe("outbound dispatch hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Existing hardening cases exercise post-approval dispatch paths.
    process.env.AI_AUTO_SOCIAL_SEND = "true";
    mockContactableOk();
    mockLeaseOk();
    mocks.resolveCredential.mockResolvedValue({
      token: "org-tok",
      source: "organisation",
      connectionRef: "manychat:int-1",
    });
    mocks.sendMessage.mockResolvedValue({
      ok: true,
      provider: "manychat",
      externalMessageId: "ext-1",
    });
    mocks.appendDomainEvent.mockResolvedValue({});
    mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        message: {
          create: vi.fn(async () => ({ id: "msg-out-1" })),
        },
        conversation: {
          update: vi.fn(async () => ({})),
        },
        outboundDispatch: {
          update: vi.fn(async () => ({
            id: "dispatch-1",
            messageId: "msg-out-1",
            externalOutcome: MessagingExternalOutcome.CONFIRMED,
          })),
        },
      };
      // appendDomainEvent uses prisma.$transaction with appendDomainEvent(tx) —
      // our markDispatchFailed also uses $transaction; handle both.
      if (typeof fn === "function") {
        return fn(tx);
      }
      return undefined;
    });
  });

  it("human send uses OutboundDispatch and confirms once", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow) // gate1 contactability
      .mockResolvedValueOnce({ activityVersion: 3, messages: [{ id: "m0" }] }) // prepare
      .mockResolvedValueOnce(openWindow); // gate2 contactability
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "manychat:int-1",
    });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.DISPATCHING,
      connectionRef: "manychat:int-1",
    });

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Human reply",
      source: "HUMAN",
      actorId: "user-1",
      idempotencyKey: "human-reply:conv-1:user-1:abc",
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("CONFIRMED");
    expect(mocks.outboundDispatchCreate).toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.appendDomainEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "MESSAGE_SENT" }),
    );
  });

  it("human double-click returns ALREADY_CONFIRMED without resend", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.CONFIRMED,
      messageId: "msg-out-1",
    });

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Human reply",
      source: "HUMAN",
      idempotencyKey: "human-reply:same",
    });

    expect(result).toMatchObject({ ok: true, code: "ALREADY_CONFIRMED" });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.outboundDispatchCreate).not.toHaveBeenCalled();
  });

  it("human API retry after DISPATCHING requires reconciliation (no duplicate send)", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.DISPATCHING,
    });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.RECONCILIATION_REQUIRED,
      failureCode: "INTERRUPTED_DURING_DISPATCH",
    });

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Human reply",
      source: "HUMAN",
      idempotencyKey: "human-reply:retry",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("RECONCILIATION_REQUIRED");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("provider confirms then response lost → RECONCILIATION_REQUIRED on throw", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 1, messages: [] })
      .mockResolvedValueOnce(openWindow);
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "manychat:int-1",
    });
    mocks.outboundDispatchUpdate
      .mockResolvedValueOnce({
        id: "dispatch-1",
        externalOutcome: MessagingExternalOutcome.DISPATCHING,
      })
      .mockResolvedValueOnce({
        id: "dispatch-1",
        externalOutcome: MessagingExternalOutcome.RECONCILIATION_REQUIRED,
      });
    mocks.sendMessage.mockRejectedValue(new Error("socket hang up after accept"));
    mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({}),
    );

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Hello",
      source: "HUMAN",
      idempotencyKey: "human-reply:uncertain",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("RECONCILIATION_REQUIRED");
  });

  it("opt-out after PREPARED blocks dispatch", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    // gate1 OK
    mocks.contactFindFirst
      .mockResolvedValueOnce({ optedOut: false, metadata: {} })
      // gate2 opted out
      .mockResolvedValueOnce({ optedOut: true, metadata: {} });
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 1, messages: [] })
      .mockResolvedValueOnce({ activityVersion: 1 });
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "manychat:int-1",
    });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.FAILED,
      failureCode: "CONTACT_OPTED_OUT",
    });
    mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({}),
    );

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Hi",
      source: "AI",
      idempotencyKey: "ai-reply:optout-race",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONTACT_OPTED_OUT");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("suppression after PREPARED blocks dispatch", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.contactFindFirst.mockResolvedValue({ optedOut: false, metadata: {} });
    mocks.isContactSuppressed
      .mockResolvedValueOnce(false) // gate1
      .mockResolvedValueOnce(true); // gate2
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 1, messages: [] })
      .mockResolvedValueOnce({ activityVersion: 1 }); // AI/follow-up stale check
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "manychat:int-1",
    });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.FAILED,
      failureCode: "CONTACT_SUPPRESSED",
    });
    mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({}),
    );

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Hi",
      source: "FOLLOW_UP",
      idempotencyKey: "followup:1",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONTACT_SUPPRESSED");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("connection revoked after PREPARED blocks dispatch", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 1, messages: [] })
      .mockResolvedValueOnce({ activityVersion: 1 })
      .mockResolvedValueOnce(openWindow);
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "manychat:int-1",
    });
    mocks.resolveCredential
      .mockResolvedValueOnce({
        token: "org-tok",
        source: "organisation",
        connectionRef: "manychat:int-1",
      })
      .mockResolvedValueOnce({
        token: null,
        source: "revoked",
        connectionRef: "manychat:int-1",
      });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.FAILED,
      failureCode: "CONNECTION_REVOKED",
    });
    mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({}),
    );

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Hi",
      source: "AUTOMATION",
      idempotencyKey: "automation:1",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONNECTION_REVOKED");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("human send preempts AI lease and cancels competing PREPARED dispatches", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 5, messages: [{ id: "m1" }] })
      .mockResolvedValueOnce(openWindow);
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-human",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "manychat:int-1",
    });
    mocks.conversationSendLeaseFindUnique.mockResolvedValue({
      conversationId: "conv-1",
      holder: "ai:conv-1",
      expiresAt: new Date(Date.now() + 10_000),
    });
    mocks.conversationSendLeaseUpdateMany.mockResolvedValue({ count: 1 });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "dispatch-human",
      externalOutcome: MessagingExternalOutcome.DISPATCHING,
    });

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Taking over",
      source: "HUMAN",
      idempotencyKey: "human-reply:takeover",
    });

    expect(result.ok).toBe(true);
    expect(mocks.outboundDispatchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureCode: "STALE_CONTEXT" }),
      }),
    );
    expect(mocks.conversationSendLeaseUpdateMany).toHaveBeenCalled();
  });

  it("human does not fail when activityVersion drifts mid-flight", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 1, messages: [] })
      .mockResolvedValueOnce(openWindow);
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "manychat:int-1",
    });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "dispatch-1",
      externalOutcome: MessagingExternalOutcome.DISPATCHING,
    });

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "Still send",
      source: "HUMAN",
      idempotencyKey: "human-reply:drift-ok",
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("CONFIRMED");
  });

  it("AI fails STALE_CONTEXT on activityVersion drift (human/follow-up collision)", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 1, messages: [{ id: "m0" }] })
      .mockResolvedValueOnce({ activityVersion: 2 }); // drifted
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "dispatch-ai",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "manychat:int-1",
    });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "dispatch-ai",
      externalOutcome: MessagingExternalOutcome.FAILED,
      failureCode: "STALE_CONTEXT",
    });

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "sub-1",
      content: "AI reply",
      source: "AI",
      idempotencyKey: "ai-reply:stale",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("STALE_CONTEXT");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
