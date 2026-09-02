import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { MESSAGING_PROVIDER } from "@/services/messaging/providers";
import { assertContactable } from "@/services/messaging/contactability";
import {
  normalizeZernioInboundMessage,
  zernioColdInstagramOutreachMode,
  createZernioMessagingAdapter,
} from "@/adapters/messaging/zernio";
import {
  createZernioConnectState,
  verifyZernioConnectState,
  resolveZernioWebhookTenant,
  verifyZernioWebhookSignature,
  isZernioWebhookConfigured,
} from "@/adapters/zernio";

const prismaMocks = vi.hoisted(() => ({
  zernioProfile: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
    updateMany: vi.fn(),
  },
  webhookEvent: {
    findUnique: vi.fn(),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "we_1", ...args.data })),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  messagingChannel: {
    findFirst: vi.fn(),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      id: "ch_z",
      ...args.create,
    })),
  },
  integration: {
    findUnique: vi.fn(),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      id: "int_z",
      isActive: true,
      ...args.create,
    })),
  },
  contact: {
    findFirst: vi.fn(),
  },
  conversation: {
    findFirst: vi.fn(),
  },
  message: {
    findFirst: vi.fn(),
  },
  contactSuppression: {
    findFirst: vi.fn(async () => null),
  },
  socialProviderUsage: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  outboundDispatch: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMocks)),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));

vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: vi.fn(async () => ({ id: "evt" })),
}));

const processInbound = vi.hoisted(() =>
  vi.fn(async () => ({
    duplicate: false,
    webhookEventId: "we_1",
    contactId: "contact_1",
    conversationId: "conv_1",
    messageId: "msg_1",
  })),
);

vi.mock("@/services/inbound-pipeline", () => ({
  processInboundMessage: (...args: unknown[]) => processInbound(...args),
}));

describe("Zernio inbound normalize + webhook → inbox", () => {
  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "zk";
    process.env.ZERNIO_WEBHOOK_SECRET = "whsec";
    process.env.AUTH_SECRET = "auth-secret-for-state-tests-32chars!!";
    resetEnvCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ZERNIO_API_KEY;
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    resetEnvCache();
    vi.unstubAllGlobals();
  });

  it("normalizes message.received into contact/thread/message ids without inventing content", () => {
    const normalized = normalizeZernioInboundMessage({
      id: "evt_1",
      event: "message.received",
      message: {
        id: "zm_1",
        platformMessageId: "mid_abc",
        text: "Hello from IG",
        createdAt: "2026-09-02T12:00:00.000Z",
      },
      conversation: { id: "zconv_1", contact: { id: "igsid_1", username: "ada" } },
      account: { id: "zacc_ig", platform: "instagram", profileId: "zprof_1" },
      profileId: "zprof_1",
    });
    expect(normalized?.provider).toBe(MESSAGING_PROVIDER.ZERNIO);
    expect(normalized?.contactExternalId).toBe("igsid_1");
    expect(normalized?.text).toBe("Hello from IG");
    expect(normalized?.externalMessageId).toBe("mid_abc");
    expect(normalized?.threadId).toContain("zconv_1");
  });

  it("rejects missing sender and non-instagram platforms", () => {
    expect(
      normalizeZernioInboundMessage({
        event: "message.received",
        message: { text: "hi" },
        account: { id: "a", platform: "instagram" },
      }),
    ).toBeNull();
    expect(
      normalizeZernioInboundMessage({
        event: "message.received",
        message: { text: "hi", id: "m" },
        conversation: { contact: { id: "c" } },
        account: { id: "a", platform: "linkedin" },
      }),
    ).toBeNull();
  });

  it("message.received webhook creates Contact/Conversation/Message via processInboundMessage", async () => {
    prismaMocks.zernioProfile.findFirst.mockResolvedValue({ organisationId: "org_1" });
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      connectedAccounts: [{ accountId: "zacc_ig", platform: "instagram" }],
    });
    prismaMocks.webhookEvent.findUnique.mockResolvedValue(null);

    const body = JSON.stringify({
      id: "evt_in_1",
      event: "message.received",
      profileId: "zprof_1",
      message: { id: "zm_1", platformMessageId: "mid_1", text: "Hi" },
      conversation: { id: "zconv_1", contact: { id: "sender_1", username: "ada" } },
      account: { id: "zacc_ig", platform: "instagram", profileId: "zprof_1" },
    });
    const sig = createHmac("sha256", "whsec").update(body).digest("hex");
    const { POST } = await import("@/app/api/webhooks/zernio/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": sig },
        body,
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(processInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: "org_1",
        contact: expect.objectContaining({ externalId: "sender_1" }),
        message: expect.objectContaining({ text: "Hi", externalId: "mid_1" }),
        leadSource: "instagram_zernio",
      }),
      expect.objectContaining({ provider: "zernio" }),
    );
  });

  it("duplicate webhook delivery is idempotent", async () => {
    prismaMocks.zernioProfile.findFirst.mockResolvedValue({ organisationId: "org_1" });
    prismaMocks.webhookEvent.findUnique.mockResolvedValue({ id: "we_existing" });
    const body = JSON.stringify({
      id: "evt_dup",
      event: "account.connected",
      profileId: "zprof_1",
    });
    const sig = createHmac("sha256", "whsec").update(body).digest("hex");
    const { POST } = await import("@/app/api/webhooks/zernio/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": sig },
        body,
      }) as never,
    );
    const json = await res.json();
    expect(json.duplicate).toBe(true);
    expect(processInbound).not.toHaveBeenCalled();
  });

  it("unknown profile is rejected (no org guess)", async () => {
    prismaMocks.zernioProfile.findFirst.mockResolvedValue(null);
    const body = JSON.stringify({
      id: "evt_x",
      event: "message.received",
      profileId: "unknown_profile",
      message: { text: "x", id: "m" },
      conversation: { contact: { id: "c" } },
      account: { id: "a", platform: "instagram" },
    });
    const sig = createHmac("sha256", "whsec").update(body).digest("hex");
    const { POST } = await import("@/app/api/webhooks/zernio/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": sig },
        body,
      }) as never,
    );
    expect(res.status).toBe(404);
    expect(processInbound).not.toHaveBeenCalled();
  });

  it("profile/account mismatch rejects", async () => {
    prismaMocks.zernioProfile.findFirst.mockResolvedValue({ organisationId: "org_1" });
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      connectedAccounts: [{ accountId: "other_acc", platform: "instagram" }],
    });
    const tenant = await resolveZernioWebhookTenant({
      profileId: "zprof_1",
      accountId: "not_that_acc",
    });
    expect(tenant.ok).toBe(false);
    if (!tenant.ok) expect(tenant.code).toBe("PROFILE_ACCOUNT_MISMATCH");
  });
});

describe("Zernio webhook security fail-closed", () => {
  afterEach(() => {
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    resetEnvCache();
  });

  it("secret absent → NOT_CONFIGURED and does not accept unsigned body", async () => {
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    resetEnvCache();
    expect(isZernioWebhookConfigured()).toBe(false);
    const { POST } = await import("@/app/api/webhooks/zernio/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        body: "{}",
      }) as never,
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("ZERNIO_NOT_CONFIGURED");
  });

  it("valid / invalid / missing signature", () => {
    process.env.ZERNIO_WEBHOOK_SECRET = "whsec";
    resetEnvCache();
    const body = '{"id":"1"}';
    const good = createHmac("sha256", "whsec").update(body).digest("hex");
    expect(verifyZernioWebhookSignature(body, good)).toBe(true);
    expect(verifyZernioWebhookSignature(body, "bad")).toBe(false);
    expect(verifyZernioWebhookSignature(body, null)).toBe(false);
  });
});

describe("Zernio outbound permitted reply + cold prospect", () => {
  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "zk";
    resetEnvCache();
    vi.clearAllMocks();
  });

  it("cold Instagram prospect is HUMAN_ACTION_REQUIRED Open+Copy", () => {
    const mode = zernioColdInstagramOutreachMode();
    expect(mode.sendMessage).toBe(false);
    expect(mode.mode).toBe("HUMAN_ACTION_REQUIRED");
    expect(mode.actions).toContain("OPEN_INSTAGRAM");
    expect(mode.actions).toContain("COPY_DM");
  });

  it("denies outbound without prior inbound on zernio channel", async () => {
    prismaMocks.contact.findFirst.mockResolvedValue({
      optedOut: false,
      metadata: {},
    });
    prismaMocks.conversation.findFirst.mockResolvedValue({
      closedAt: null,
      aiPaused: false,
      handlingMode: "AI",
      lastInboundAt: null,
      messagingWindowExpiresAt: null,
      humanMessagingWindowExpiresAt: null,
      metadata: {},
    });
    prismaMocks.message.findFirst.mockResolvedValue(null);

    await expect(
      assertContactable({
        organisationId: "org_1",
        contactId: "c1",
        conversationId: "conv1",
        channel: "zernio",
        actionType: "HUMAN_REPLY",
      }),
    ).rejects.toMatchObject({ code: "ZERNIO_NO_PRIOR_INBOUND" });
  });

  it("suppressed contact denial", async () => {
    prismaMocks.contact.findFirst.mockResolvedValue({ optedOut: false, metadata: {} });
    vi.doMock("@/services/messaging/suppression", () => ({
      isContactSuppressed: vi.fn(async () => true),
    }));
    // Direct metadata path: opted out / DNC already covered elsewhere — use optedOut
    prismaMocks.contact.findFirst.mockResolvedValue({ optedOut: true, metadata: {} });
    await expect(
      assertContactable({
        organisationId: "org_1",
        contactId: "c1",
        channel: "zernio",
        actionType: "HUMAN_REPLY",
      }),
    ).rejects.toMatchObject({ code: "CONTACT_OPTED_OUT" });
  });

  it("permitted reply adapter calls Zernio inbox send endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: "out_1" }),
      })),
    );
    const adapter = createZernioMessagingAdapter();
    const result = await adapter.sendMessage({
      organisationId: "org_1",
      contactExternalId: "sender_1",
      text: "Thanks!",
      metadata: { zernioAccountId: "zacc_ig", zernioConversationId: "zconv_1" },
    });
    expect(result.ok).toBe(true);
    expect(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
      "/inbox/conversations/zconv_1/messages",
    );
  });

  it("adapter refuses send without conversation binding (cold)", async () => {
    const adapter = createZernioMessagingAdapter();
    const result = await adapter.sendMessage({
      organisationId: "org_1",
      contactExternalId: "x",
      text: "cold",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.toLowerCase()).toMatch(/requires|permitted/);
  });
});

describe("Zernio callback tenant binding", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "auth-secret-for-state-tests-32chars!!";
    resetEnvCache();
  });

  it("callback state binds org and rejects cross-org / expired / tamper", () => {
    const state = createZernioConnectState("org_a", 60);
    expect(verifyZernioConnectState(state, "org_a").ok).toBe(true);
    expect(verifyZernioConnectState(state, "org_b")).toEqual({
      ok: false,
      code: "STATE_ORG_MISMATCH",
    });
    expect(verifyZernioConnectState(state.slice(0, -2) + "xx", "org_a")).toEqual({
      ok: false,
      code: "STATE_TAMPERED",
    });
    const expired = createZernioConnectState("org_a", -10);
    expect(verifyZernioConnectState(expired, "org_a")).toEqual({
      ok: false,
      code: "STATE_EXPIRED",
    });
  });
});
