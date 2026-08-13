import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => {
  const updateMany = vi.fn(async () => ({ count: 2 }));
  const findMany = vi.fn();
  const findFirst = vi.fn();
  const findUnique = vi.fn();
  return {
    prisma: {
      followUp: { updateMany },
      messagingChannel: { findMany },
      organisation: { findFirst },
      organisationMember: { findFirst },
      lead: { findFirst, updateMany },
      conversation: { findFirst },
      integration: { findUnique },
      __mocks: { updateMany, findMany, findFirst, findUnique },
    },
  };
});

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ MANYCHAT_WEBHOOK_SECRET: "global-webhook-secret-value" }),
}));

vi.mock("@/lib/crypto", () => ({
  decryptSecret: (v: string) => v.replace(/^enc:/, ""),
  encryptSecret: (v: string) => `enc:${v}`,
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { prisma } from "@/lib/db";
import { cancelPendingFollowUps, cancelFollowUpsOnOptOut } from "@/services/followups";
import {
  resolveManyChatWebhookOrganisation,
  validateOrgScopedManyChatSecret,
} from "@/services/manychat-secrets";

type MockBag = {
  updateMany: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
};

const mocks = (prisma as unknown as { __mocks: MockBag }).__mocks;

describe("org isolation — follow-up cancels", () => {
  beforeEach(() => {
    mocks.updateMany.mockClear();
    mocks.updateMany.mockResolvedValue({ count: 2 });
  });

  it("cancelPendingFollowUps requires organisationId in the where clause", async () => {
    await cancelPendingFollowUps({
      organisationId: "org_a",
      conversationId: "conv_foreign",
      reason: "test",
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organisationId: "org_a",
          conversationId: "conv_foreign",
        }),
      }),
    );
  });

  it("cancelFollowUpsOnOptOut scopes by organisationId", async () => {
    await cancelFollowUpsOnOptOut({
      organisationId: "org_a",
      contactId: "contact_foreign",
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organisationId: "org_a",
          contactId: "contact_foreign",
        }),
      }),
    );
  });
});

describe("org isolation — ManyChat webhook org resolution", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
    mocks.findFirst.mockReset();
    mocks.findUnique.mockReset();
  });

  it("rejects global secret + arbitrary payload organisationId (cross-tenant)", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.findUnique.mockResolvedValue(null);

    const result = await resolveManyChatWebhookOrganisation({
      secretHeader: "global-webhook-secret-value",
      payloadOrganisationId: "org_victim",
      channelExternalId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.error.toLowerCase()).toContain("global");
  });

  it("accepts global secret only when channel_id uniquely maps to an org", async () => {
    mocks.findMany.mockResolvedValue([{ organisationId: "org_from_channel", id: "ch1" }]);
    mocks.findUnique.mockResolvedValue(null);

    const result = await resolveManyChatWebhookOrganisation({
      secretHeader: "global-webhook-secret-value",
      payloadOrganisationId: "org_spoofed_in_payload",
      channelExternalId: "channel_abc",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.organisationId).toBe("org_from_channel");
    expect(result.authMethod).toBe("channel_mapping");
  });

  it("accepts org-scoped secret for the claimed org", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.findUnique.mockResolvedValue({
      credentials: [{ keyName: "webhook_secret", encryptedValue: "enc:org-secret-abc" }],
    });

    const result = await resolveManyChatWebhookOrganisation({
      secretHeader: "org-secret-abc",
      payloadOrganisationId: "org_owner",
      channelExternalId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.organisationId).toBe("org_owner");
    expect(result.authMethod).toBe("org_scoped_secret");
  });

  it("validateOrgScopedManyChatSecret never accepts the global secret", async () => {
    mocks.findUnique.mockResolvedValue({
      credentials: [{ keyName: "webhook_secret", encryptedValue: "enc:org-secret-abc" }],
    });
    await expect(
      validateOrgScopedManyChatSecret("global-webhook-secret-value", "org_owner"),
    ).resolves.toBe(false);
  });
});

describe("org isolation — assignee membership gate", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
  });

  it("rejects assignUserId that is not an organisation member", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    const member = await prisma.organisationMember.findFirst({
      where: {
        organisationId: "org_a",
        userId: "user_from_other_org",
        user: { deletedAt: null, isActive: true, isSuspended: false },
      },
      select: { id: true },
    });
    expect(member).toBeNull();
  });
});

describe("org isolation — bookings lead/conversation verification", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
  });

  it("rejects cross-org leadId when organisation filter is applied", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    const lead = await prisma.lead.findFirst({
      where: {
        id: "lead_other_org",
        organisationId: "org_attacker",
        contactId: "contact_attacker",
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(lead).toBeNull();
  });

  it("rejects cross-org conversationId when organisation filter is applied", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: "conv_other_org",
        organisationId: "org_attacker",
        contactId: "contact_attacker",
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(conversation).toBeNull();
  });
});
