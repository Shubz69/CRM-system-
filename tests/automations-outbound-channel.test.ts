import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contactFindFirst: vi.fn(),
  conversationFindFirst: vi.fn(),
  agentConfigurationFindFirst: vi.fn(),
  automationRuleFindMany: vi.fn(),
  automationExecutionCreate: vi.fn(),
  prepareAndSendOutbound: vi.fn(),
  notifyOrganisationOwners: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    contact: { findFirst: mocks.contactFindFirst },
    conversation: { findFirst: mocks.conversationFindFirst },
    agentConfiguration: { findFirst: mocks.agentConfigurationFindFirst },
    automationRule: { findMany: mocks.automationRuleFindMany },
    automationExecution: { create: mocks.automationExecutionCreate },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/services/notifications", () => ({
  createNotification: vi.fn(),
  notifyOrganisationOwners: (...args: unknown[]) => mocks.notifyOrganisationOwners(...args),
}));
vi.mock("@/services/followups", () => ({
  scheduleFollowUps: vi.fn(),
  cancelPendingFollowUps: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/services/automation-os", () => ({
  buildWorkflowSteps: () => [],
  createApprovalRequest: vi.fn(),
  isOutboundAction: (type: string) => type === "send_message" || type === "send_booking_link",
}));
vi.mock("@/services/messaging/outbound", () => ({
  prepareAndSendOutbound: (...args: unknown[]) => mocks.prepareAndSendOutbound(...args),
}));
vi.mock("@/lib/ai-auto-social-send", () => ({ isAiAutoSocialSendEnabled: () => true }));

import { executeAction, runAutomations } from "@/services/automations";

const context = {
  organisationId: "org-1",
  contactId: "contact-1",
  conversationId: "conv-1",
  leadId: "lead-1",
  triggerType: "lead_replied",
};

function withChannel(provider: string | null) {
  mocks.conversationFindFirst.mockResolvedValue({
    id: "conv-1",
    externalThreadId: "thread-1",
    messagingChannel: provider ? { provider } : null,
  });
}

describe("automation outbound sends use the conversation's channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.contactFindFirst.mockResolvedValue({
      id: "contact-1",
      optedOut: false,
      identifiers: [
        { channel: "manychat", identifier: "manychat:mc-sub-1" },
        { channel: "zernio", identifier: "zernio:ig-user-9" },
      ],
    });
    mocks.agentConfigurationFindFirst.mockResolvedValue(null);
    mocks.prepareAndSendOutbound.mockResolvedValue({
      ok: true,
      code: "CONFIRMED",
      dispatch: { id: "d-1", messageId: "m-1", externalOutcome: "CONFIRMED" },
    });
    mocks.automationExecutionCreate.mockResolvedValue({});
  });

  it("sends a Zernio conversation via Zernio with the Zernio contact id", async () => {
    withChannel("zernio");

    await executeAction({ type: "send_message", message: "Hi there" }, context);

    expect(mocks.prepareAndSendOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "zernio",
        channel: "zernio",
        contactExternalId: "ig-user-9",
        threadId: "thread-1",
      }),
    );
  });

  it("keeps ManyChat for conversations without a channel", async () => {
    withChannel(null);

    await executeAction({ type: "send_message", message: "Hi there" }, context);

    expect(mocks.prepareAndSendOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "manychat",
        channel: "manychat",
        contactExternalId: "mc-sub-1",
      }),
    );
  });

  it("records the execution as failed when the send fails", async () => {
    withChannel("meta_instagram");
    mocks.automationRuleFindMany.mockResolvedValue([
      {
        id: "rule-1",
        name: "Reply on DM",
        triggerType: "lead_replied",
        conditions: {},
        actions: [{ type: "send_message", message: "Thanks!" }],
        requiresApproval: false,
      },
    ]);
    mocks.prepareAndSendOutbound.mockResolvedValue({ ok: false, code: "PROVIDER_SEND_FAILED" });

    const executed = await runAutomations(context);

    expect(executed).toBe(0);
    expect(mocks.automationExecutionCreate).toHaveBeenCalledTimes(1);
    expect(mocks.automationExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("PROVIDER_SEND_FAILED"),
        }),
      }),
    );
  });

  it("records success when the send is confirmed", async () => {
    withChannel("zernio");
    mocks.automationRuleFindMany.mockResolvedValue([
      {
        id: "rule-1",
        name: "Reply on DM",
        triggerType: "lead_replied",
        conditions: {},
        actions: [{ type: "send_message", message: "Thanks!" }],
        requiresApproval: false,
      },
    ]);

    await runAutomations(context);

    expect(mocks.automationExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "success" }) }),
    );
  });
});
