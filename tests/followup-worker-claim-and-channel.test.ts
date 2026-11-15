import { beforeEach, describe, expect, it, vi } from "vitest";
import { FollowUpStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  followUpFindMany: vi.fn(),
  followUpUpdateMany: vi.fn(),
  followUpUpdate: vi.fn(),
  organisationFindUnique: vi.fn(),
  createApproval: vi.fn(),
  send: vi.fn(),
  autoSend: { on: false },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    followUp: {
      findMany: mocks.followUpFindMany,
      updateMany: mocks.followUpUpdateMany,
      update: mocks.followUpUpdate,
    },
    organisation: { findUnique: mocks.organisationFindUnique },
  },
}));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/services/failed-jobs", () => ({ recordFailedJob: vi.fn(async () => undefined) }));
vi.mock("@/services/messaging/contactability", () => ({ assertContactable: vi.fn(async () => undefined) }));
vi.mock("@/services/messaging/suppression", () => ({ isContactSuppressed: vi.fn(async () => false) }));
vi.mock("@/services/messaging/outbound", () => ({ prepareAndSendOutbound: mocks.send }));
vi.mock("@/services/automation-os", () => ({ createAiOutboundApprovalRequest: mocks.createApproval }));
vi.mock("@/lib/ai-auto-social-send", () => ({ isAiAutoSocialSendEnabled: () => mocks.autoSend.on }));
vi.mock("@/jobs/follow-ups", () => ({ enqueueFollowUpCheck: vi.fn() }));
vi.mock("@/jobs/queues", () => ({ getFollowUpQueue: vi.fn() }));

import { processDueFollowUps } from "@/workers/followups";

const scheduledFor = new Date("2026-11-15T10:00:00Z");
function dueFollowUp(provider: string | null) {
  return {
    id: "fu_1",
    organisationId: "org_1",
    contactId: "contact_1",
    conversationId: "conv_1",
    leadId: "lead_1",
    status: FollowUpStatus.SCHEDULED,
    scheduledFor,
    messageBody: "Just checking in",
    contact: {
      optedOut: false,
      identifiers: [
        { channel: "manychat", identifier: "manychat:mc_123" },
        { channel: "zernio", identifier: "zernio:ig_987" },
      ],
    },
    conversation: {
      id: "conv_1",
      aiPaused: false,
      closedAt: null,
      handlingMode: "AI",
      activityVersion: 9,
      externalThreadId: null,
      lastInboundAt: new Date(),
      messagingWindowExpiresAt: new Date(Date.now() + 86_400_000),
      humanMessagingWindowExpiresAt: new Date(Date.now() + 86_400_000),
      messagingChannel: provider ? { provider } : null,
    },
  };
}

describe("follow-up sender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.autoSend.on = false;
    mocks.followUpUpdateMany.mockResolvedValue({ count: 1 });
    mocks.followUpUpdate.mockResolvedValue({});
    mocks.organisationFindUnique.mockResolvedValue({ autopilotConfig: { followUps: "approval_required" } });
    mocks.createApproval.mockResolvedValue("apr_1");
    mocks.send.mockResolvedValue({ ok: true, dispatch: { id: "d1", messageId: "m1" } });
  });

  it("claims each follow-up first and skips one another run already took", async () => {
    mocks.followUpFindMany.mockResolvedValue([dueFollowUp("manychat")]);
    mocks.followUpUpdateMany.mockResolvedValue({ count: 0 });
    await processDueFollowUps();
    expect(mocks.followUpUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "fu_1", status: FollowUpStatus.SCHEDULED, scheduledFor },
      }),
    );
    expect(mocks.createApproval).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("addresses the conversation's own channel (Zernio), not ManyChat", async () => {
    mocks.followUpFindMany.mockResolvedValue([dueFollowUp("zernio")]);
    await processDueFollowUps();
    expect(mocks.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          provider: "zernio",
          contactExternalId: "ig_987",
          expectedActivityVersion: 9,
        }),
      }),
    );
  });

  it("respects the workspace's 'approval required' setting even when auto-send is on", async () => {
    mocks.autoSend.on = true;
    mocks.followUpFindMany.mockResolvedValue([dueFollowUp("manychat")]);
    await processDueFollowUps();
    expect(mocks.createApproval).toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sends directly only when follow-ups are automatic and auto-send is on", async () => {
    mocks.autoSend.on = true;
    mocks.organisationFindUnique.mockResolvedValue({ autopilotConfig: { followUps: "automatic" } });
    mocks.followUpFindMany.mockResolvedValue([dueFollowUp("manychat")]);
    await processDueFollowUps();
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "manychat", contactExternalId: "mc_123", expectedActivityVersion: 9 }),
    );
  });

  it("cancels follow-ups when the workspace has switched them off", async () => {
    mocks.organisationFindUnique.mockResolvedValue({ autopilotConfig: { followUps: "disabled" } });
    mocks.followUpFindMany.mockResolvedValue([dueFollowUp("manychat")]);
    await processDueFollowUps();
    expect(mocks.followUpUpdate).toHaveBeenCalledWith({
      where: { id: "fu_1" },
      data: { status: FollowUpStatus.CANCELLED, cancelReason: "Follow-ups are switched off" },
    });
    expect(mocks.createApproval).not.toHaveBeenCalled();
  });
});
