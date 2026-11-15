import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalRequestStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  approvalCreate: vi.fn(),
  approvalUpdateMany: vi.fn(),
  approvalFindFirst: vi.fn(),
  approvalFindMany: vi.fn(),
  approvalUpdate: vi.fn(),
  followUpUpdateMany: vi.fn(),
  messageFindFirst: vi.fn(),
  dispatch: vi.fn(),
  followThrough: vi.fn(async () => undefined),
}));

vi.mock("@/services/messaging/ai-reply-follow-through", () => ({
  runAiReplyFollowThrough: (...args: unknown[]) => mocks.followThrough(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    approvalRequest: {
      create: mocks.approvalCreate,
      updateMany: mocks.approvalUpdateMany,
      findFirst: mocks.approvalFindFirst,
      findMany: mocks.approvalFindMany,
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
    mocks.approvalFindMany.mockResolvedValue([]);
  });

  it("a new draft retires older pending drafts for the same conversation", async () => {
    mocks.approvalFindMany.mockResolvedValue([
      { id: "apr_older", payload: { conversationId: "conv_1", expectedActivityVersion: 3 } },
      { id: "apr_legacy", payload: { conversationId: "conv_1" } },
    ]);
    await createAiOutboundApprovalRequest({
      organisationId: "org_1",
      title: "Approve AI Instagram reply",
      payload: draftPayload,
    });
    expect(mocks.approvalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organisationId: "org_1",
          kind: "ai_outbound_message",
          status: ApprovalRequestStatus.PENDING,
          payload: { path: ["conversationId"], equals: "conv_1" },
        }),
      }),
    );
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["apr_older", "apr_legacy"] }, status: ApprovalRequestStatus.PENDING },
      data: expect.objectContaining({ status: ApprovalRequestStatus.EXPIRED }),
    });
    // Retire first, then create — the new draft itself must stay pending.
    expect(mocks.approvalUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.approvalCreate.mock.invocationCallOrder[0],
    );
  });

  it("a draft for an older message never retires a newer draft that finished first", async () => {
    mocks.approvalFindMany.mockResolvedValue([
      { id: "apr_newer", payload: { conversationId: "conv_1", expectedActivityVersion: 5 } },
    ]);
    const id = await createAiOutboundApprovalRequest({
      organisationId: "org_1",
      title: "Approve AI Instagram reply",
      payload: draftPayload, // version 4
    });
    expect(id).toBe("apr_newer");
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled();
    expect(mocks.approvalCreate).not.toHaveBeenCalled();
  });

  it("two approvers (or a double-click) can't both send — the decision is claimed atomically", async () => {
    mocks.approvalUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      decideApprovalRequest({ organisationId: "org_1", approvalId: "apr_1", decision: "APPROVED" }),
    ).rejects.toThrow(/already decided/);
    expect(mocks.dispatch).not.toHaveBeenCalled();
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

  it("a provider rejection leaves the queue (a retry would hit the same recorded failure forever)", async () => {
    mocks.dispatch.mockResolvedValue({ ok: false, code: "FAILED" });
    await expect(
      decideApprovalRequest({ organisationId: "org_1", approvalId: "apr_1", decision: "APPROVED" }),
    ).rejects.toThrow(/rejected it/);
    expect(mocks.approvalUpdate).toHaveBeenLastCalledWith({
      where: { id: "apr_1" },
      data: expect.objectContaining({ status: ApprovalRequestStatus.EXPIRED }),
    });
  });

  it("uncertain delivery is reported as uncertain, not as 'not sent'", async () => {
    mocks.dispatch.mockResolvedValue({ ok: false, code: "RECONCILIATION_REQUIRED" });
    await expect(
      decideApprovalRequest({ organisationId: "org_1", approvalId: "apr_1", decision: "APPROVED" }),
    ).rejects.toThrow(/Delivery uncertain/);
  });

  it("a momentary send clash puts the draft back in the queue", async () => {
    mocks.dispatch.mockResolvedValue({ ok: false, code: "LEASE_UNAVAILABLE" });
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
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: "apr_1", status: ApprovalRequestStatus.PENDING },
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

  it("Approve & Send records the booking offer and schedules follow-ups once delivered", async () => {
    const plan = {
      offeredBookingUrl: "https://cal.example.test/glow",
      followUp: { intent: "booking", qualificationStatus: "qualified", meetingBooked: true },
    };
    mocks.approvalFindFirst.mockResolvedValue({
      ...pendingApproval(),
      payload: { ...draftPayload, leadId: "lead_1", followThrough: plan },
    });
    mocks.dispatch.mockResolvedValue({ ok: true, code: "CONFIRMED", dispatch: { id: "d1", messageId: "m1" } });
    await decideApprovalRequest({ organisationId: "org_1", approvalId: "apr_1", decision: "APPROVED" });
    expect(mocks.followThrough).toHaveBeenCalledWith({
      organisationId: "org_1",
      contactId: "contact_1",
      conversationId: "conv_1",
      leadId: "lead_1",
      plan,
    });
  });

  it("a failing follow-through never turns a delivered approval into an error", async () => {
    mocks.approvalFindFirst.mockResolvedValue({
      ...pendingApproval(),
      payload: { ...draftPayload, followThrough: { followUp: { meetingBooked: false } } },
    });
    mocks.dispatch.mockResolvedValue({ ok: true, code: "CONFIRMED", dispatch: { id: "d1", messageId: "m1" } });
    mocks.followThrough.mockRejectedValueOnce(new Error("db hiccup"));
    const result = await decideApprovalRequest({
      organisationId: "org_1",
      approvalId: "apr_1",
      decision: "APPROVED",
    });
    expect(result.actionsRun).toBe(1);
  });

  it("an already-delivered draft (idempotent replay) counts as sent", async () => {
    mocks.approvalFindFirst.mockResolvedValue({
      ...pendingApproval(),
      payload: { ...draftPayload, followThrough: { followUp: { meetingBooked: false } } },
    });
    mocks.dispatch.mockResolvedValue({ ok: false, code: "ALREADY_CONFIRMED", dispatch: { id: "d1", messageId: "m1" } });
    const result = await decideApprovalRequest({
      organisationId: "org_1",
      approvalId: "apr_1",
      decision: "APPROVED",
    });
    expect(result.actionsRun).toBe(1);
    // Follow-through already ran on the original delivery — don't double-schedule.
    expect(mocks.followThrough).not.toHaveBeenCalled();
  });
});
