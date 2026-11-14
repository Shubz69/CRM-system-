import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalRequestStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  approvalCreate: vi.fn(),
  approvalUpdateMany: vi.fn(),
  approvalFindFirst: vi.fn(),
  approvalUpdate: vi.fn(),
  followUpUpdateMany: vi.fn(),
  messageFindFirst: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    approvalRequest: {
      create: mocks.approvalCreate,
      updateMany: mocks.approvalUpdateMany,
      findFirst: mocks.approvalFindFirst,
      update: mocks.approvalUpdate,
    },
    followUp: { updateMany: mocks.followUpUpdateMany },
    message: { findFirst: mocks.messageFindFirst },
  },
}));

vi.mock("@/kernel", () => ({
  ensureBuiltinToolsRegistered: vi.fn(),
  evaluateToolPolicy: vi.fn(() => ({ effect: "allow" })),
}));

vi.mock("@/services/messaging/outbound", () => ({
  dispatchOutboundMessage: (...args: unknown[]) => mocks.dispatch(...args),
}));

import {
  createAiOutboundApprovalRequest,
  decideApprovalRequest,
} from "@/services/automation-os";

const draftPayload = {
  originalDraft: "Thanks for reaching out!",
  finalContent: "Thanks for reaching out!",
  conversationId: "conv_1",
  contactId: "contact_1",
  contactExternalId: "sub_1",
  provider: "manychat",
  channel: "manychat",
  source: "AI" as const,
  holder: "ai:conv_1:msg_1",
  idempotencyKey: "ai-reply:msg_1",
  inboundMessageId: "msg_1",
  expectedActivityVersion: 4,
};

function pendingApproval() {
  return {
    id: "apr_1",
    organisationId: "org_1",
    kind: "ai_outbound_message",
    status: ApprovalRequestStatus.PENDING,
    payload: draftPayload,
  };
}

describe("AI reply drafts awaiting approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.approvalCreate.mockResolvedValue({ id: "apr_new" });
    mocks.approvalUpdateMany.mockResolvedValue({ count: 2 });
    mocks.approvalUpdate.mockResolvedValue({});
    mocks.approvalFindFirst.mockResolvedValue(pendingApproval());
  });

  it("a new draft retires older pending drafts for the same conversation", async () => {
    await createAiOutboundApprovalRequest({
      organisationId: "org_1",
      title: "Approve AI Instagram reply",
      payload: draftPayload,
    });
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organisationId: "org_1",
        kind: "ai_outbound_message",
        status: ApprovalRequestStatus.PENDING,
        payload: { path: ["conversationId"], equals: "conv_1" },
      }),
      data: expect.objectContaining({ status: ApprovalRequestStatus.EXPIRED }),
    });
    // Retire first, then create — the new draft itself must stay pending.
    expect(mocks.approvalUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.approvalCreate.mock.invocationCallOrder[0],
    );
  });

  it("Approve & Send checks the conversation has not moved on since the draft", async () => {
    mocks.dispatch.mockResolvedValue({ ok: true, code: "CONFIRMED", dispatch: { id: "d1", messageId: "m1" } });
    await decideApprovalRequest({ organisationId: "org_1", approvalId: "apr_1", decision: "APPROVED" });
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ expectedActivityVersion: 4 }));
  });

  it("a stale draft is refused with a clear reason and leaves the queue", async () => {
    mocks.dispatch.mockResolvedValue({ ok: false, code: "STALE_CONTEXT" });
    await expect(
      decideApprovalRequest({ organisationId: "org_1", approvalId: "apr_1", decision: "APPROVED" }),
    ).rejects.toThrow(/moved on since this draft/);
    expect(mocks.approvalUpdate).toHaveBeenLastCalledWith({
      where: { id: "apr_1" },
      data: expect.objectContaining({ status: ApprovalRequestStatus.EXPIRED }),
    });
  });

  it("a transient provider failure puts the draft back in the queue instead of 'approved but unsent'", async () => {
    mocks.dispatch.mockResolvedValue({ ok: false, code: "FAILED" });
    await expect(
      decideApprovalRequest({ organisationId: "org_1", approvalId: "apr_1", decision: "APPROVED" }),
    ).rejects.toThrow(/still waiting/);
    expect(mocks.approvalUpdate).toHaveBeenLastCalledWith({
      where: { id: "apr_1" },
      data: { status: ApprovalRequestStatus.PENDING, decidedAt: null, decidedByUserId: null },
    });
  });

  it("a draft queued before versions were recorded is refused if anyone wrote since", async () => {
    const legacyPayload: Record<string, unknown> = { ...draftPayload };
    delete legacyPayload.expectedActivityVersion;
    mocks.approvalFindFirst.mockResolvedValue({
      ...pendingApproval(),
      payload: legacyPayload,
      createdAt: new Date("2026-11-14T15:52:11Z"),
    });
    mocks.messageFindFirst.mockResolvedValue({ id: "msg_after" });
    await expect(
      decideApprovalRequest({ organisationId: "org_1", approvalId: "apr_1", decision: "APPROVED" }),
    ).rejects.toThrow(/moved on since this draft/);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.approvalUpdate).toHaveBeenCalledWith({
      where: { id: "apr_1" },
      data: expect.objectContaining({ status: ApprovalRequestStatus.EXPIRED }),
    });
  });

  it("a legacy draft with no newer messages can still be approved", async () => {
    const legacyPayload: Record<string, unknown> = { ...draftPayload };
    delete legacyPayload.expectedActivityVersion;
    mocks.approvalFindFirst.mockResolvedValue({
      ...pendingApproval(),
      payload: legacyPayload,
      createdAt: new Date("2026-11-14T15:52:11Z"),
    });
    mocks.messageFindFirst.mockResolvedValue(null);
    mocks.dispatch.mockResolvedValue({ ok: true, code: "CONFIRMED", dispatch: { id: "d1", messageId: "m1" } });
    const result = await decideApprovalRequest({
      organisationId: "org_1",
      approvalId: "apr_1",
      decision: "APPROVED",
    });
    expect(result.actionsRun).toBe(1);
  });

  it("an already-delivered draft (idempotent replay) counts as sent", async () => {
    mocks.dispatch.mockResolvedValue({ ok: false, code: "ALREADY_CONFIRMED", dispatch: { id: "d1", messageId: "m1" } });
    const result = await decideApprovalRequest({
      organisationId: "org_1",
      approvalId: "apr_1",
      decision: "APPROVED",
    });
    expect(result.actionsRun).toBe(1);
  });
});
