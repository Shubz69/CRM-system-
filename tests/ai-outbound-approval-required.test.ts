import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingExternalOutcome } from "@prisma/client";
import { isAiAutoSocialSendEnabled } from "@/lib/ai-auto-social-send";
import { DEFAULT_AUTOPILOT_CONFIG } from "@/lib/autopilot-config";

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
  approvalRequestFindFirst: vi.fn(),
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
    approvalRequest: { findFirst: mocks.approvalRequestFindFirst },
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
    name: "zernio",
    sendMessage: mocks.sendMessage,
  })),
}));

vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: (...args: unknown[]) => mocks.appendDomainEvent(...args),
}));

import { dispatchOutboundMessage } from "@/services/messaging/outbound";

describe("AI outbound requires human approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AI_AUTO_SOCIAL_SEND;
    mocks.contactFindFirst.mockResolvedValue({ optedOut: false, metadata: {} });
    mocks.isContactSuppressed.mockResolvedValue(false);
    mocks.conversationSendLeaseFindUnique.mockResolvedValue(null);
    mocks.conversationSendLeaseCreate.mockResolvedValue({});
    mocks.conversationSendLeaseDeleteMany.mockResolvedValue({ count: 1 });
    mocks.outboundDispatchUpdateMany.mockResolvedValue({ count: 0 });
    mocks.resolveCredential.mockResolvedValue({
      token: "tok",
      source: "organisation",
      connectionRef: "zernio:acc-1",
    });
    mocks.sendMessage.mockResolvedValue({
      ok: true,
      provider: "zernio",
      externalMessageId: "ext-1",
    });
    mocks.appendDomainEvent.mockResolvedValue({});
    mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        message: {
          create: vi.fn(async () => ({ id: "msg-1" })),
        },
        conversation: {
          update: vi.fn(async () => ({})),
        },
        outboundDispatch: {
          update: vi.fn(async () => ({
            id: "d1",
            messageId: "msg-1",
            externalOutcome: MessagingExternalOutcome.CONFIRMED,
          })),
        },
      };
      if (typeof fn === "function") return fn(tx);
      return undefined;
    });
  });

  afterEach(() => {
    delete process.env.AI_AUTO_SOCIAL_SEND;
  });

  const openWindow = {
    closedAt: null,
    aiPaused: false,
    handlingMode: "AI",
    lastInboundAt: new Date(),
    messagingWindowExpiresAt: new Date(Date.now() + 60_000),
    humanMessagingWindowExpiresAt: new Date(Date.now() + 60_000),
    metadata: {},
  };

  it("defaults AI_AUTO_SOCIAL_SEND to disabled and autopilot aiResponses to approval_required", () => {
    expect(isAiAutoSocialSendEnabled()).toBe(false);
    expect(DEFAULT_AUTOPILOT_CONFIG.aiResponses).toBe("approval_required");
  });

  it("AI source cannot call provider send without approved ApprovalRequest", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.approvalRequestFindFirst.mockResolvedValue(null);

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "ig-1",
      content: "AI draft reply",
      source: "AI",
      idempotencyKey: "ai-reply:1",
      provider: "zernio",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.outboundDispatchCreate).not.toHaveBeenCalled();
  });

  it("FOLLOW_UP source is blocked without approval when auto-send disabled", async () => {
    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "ig-1",
      content: "Follow-up draft",
      source: "FOLLOW_UP",
      idempotencyKey: "followup:1",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("HUMAN source may send without ApprovalRequest", async () => {
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 3, messages: [{ id: "m0" }] })
      .mockResolvedValueOnce(openWindow);
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "d1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "zernio:acc-1",
    });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "d1",
      externalOutcome: MessagingExternalOutcome.DISPATCHING,
      connectionRef: "zernio:acc-1",
    });

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "ig-1",
      content: "Typed by human",
      source: "HUMAN",
      idempotencyKey: "human:1",
      actorId: "user-1",
    });

    expect(result).toMatchObject({ ok: true, code: "CONFIRMED" });
    expect(mocks.sendMessage).toHaveBeenCalled();
    expect(mocks.approvalRequestFindFirst).not.toHaveBeenCalled();
  });

  it("AI may send only when metadata.approvalRequestId points to APPROVED row", async () => {
    mocks.approvalRequestFindFirst.mockResolvedValue({ id: "apr_1" });
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
    mocks.conversationFindFirst
      .mockResolvedValueOnce(openWindow)
      .mockResolvedValueOnce({ activityVersion: 1, messages: [] })
      .mockResolvedValueOnce({ activityVersion: 1 })
      .mockResolvedValueOnce(openWindow);
    mocks.outboundDispatchCreate.mockResolvedValue({
      id: "d1",
      externalOutcome: MessagingExternalOutcome.PREPARED,
      connectionRef: "zernio:acc-1",
    });
    mocks.outboundDispatchUpdate.mockResolvedValue({
      id: "d1",
      externalOutcome: MessagingExternalOutcome.DISPATCHING,
      connectionRef: "zernio:acc-1",
    });

    const result = await dispatchOutboundMessage({
      organisationId: "org-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      contactExternalId: "ig-1",
      content: "Approved final",
      source: "AI",
      idempotencyKey: "ai-reply:approved",
      metadata: {
        approvalRequestId: "apr_1",
        originalDraft: "Original AI draft",
        finalContent: "Approved final",
        approvedByUserId: "user-1",
      },
    });

    expect(result).toMatchObject({ ok: true, code: "CONFIRMED" });
    expect(mocks.approvalRequestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "apr_1",
          organisationId: "org-1",
          status: "APPROVED",
        }),
      }),
    );
    expect(mocks.sendMessage).toHaveBeenCalled();
  });
});
