import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processInboundMessage: vi.fn(),
  resolveOrganisationByMetaIgAccountId: vi.fn(),
  resolveManyChatWebhookOrganisation: vi.fn(),
  messagingChannelFindFirst: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  assertProductionSecretsConfigured: () => undefined,
  assertMetaInstagramMessagingConfigured: () => undefined,
  MetaInstagramNotConfiguredError: class MetaInstagramNotConfiguredError extends Error {},
  metaInstagramNotConfiguredResponse: (status = 503) => Response.json({}, { status }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db", () => ({
  prisma: { messagingChannel: { findFirst: mocks.messagingChannelFindFirst } },
}));
vi.mock("@/services/usage", () => ({ recordUsage: vi.fn() }));
vi.mock("@/services/inbound-pipeline", () => ({
  processInboundMessage: (...args: unknown[]) => mocks.processInboundMessage(...args),
}));
vi.mock("@/services/messaging/meta-instagram", () => ({
  hashMetaPayload: () => "hash",
  resolveOrganisationByMetaIgAccountId: (...args: unknown[]) =>
    mocks.resolveOrganisationByMetaIgAccountId(...args),
  verifyMetaWebhookChallenge: () => null,
  verifyMetaWebhookSignature: () => true,
}));
vi.mock("@/services/manychat-secrets", () => ({
  resolveManyChatWebhookOrganisation: (...args: unknown[]) =>
    mocks.resolveManyChatWebhookOrganisation(...args),
}));

import { POST as metaPost } from "@/app/api/webhooks/meta/instagram/route";
import { POST as manyChatPost } from "@/app/api/webhooks/manychat/route";

function metaRequest(messages: Array<{ mid: string; text: string }>) {
  const payload = {
    object: "instagram",
    entry: [
      {
        id: "ig-biz-1",
        messaging: messages.map((m) => ({
          sender: { id: "ig-user-1" },
          recipient: { id: "ig-biz-1" },
          timestamp: Date.now(),
          message: { mid: m.mid, text: m.text },
        })),
      },
    ],
  };
  return new Request("http://localhost/api/webhooks/meta/instagram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=ok" },
    body: JSON.stringify(payload),
  }) as never;
}

describe("Meta Instagram webhook asks Meta to retry failed DMs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOrganisationByMetaIgAccountId.mockResolvedValue({
      organisationId: "org-1",
      channelId: "ch-1",
    });
  });

  it("returns 5xx when processing a message failed", async () => {
    mocks.processInboundMessage.mockRejectedValue(new Error("Transaction already closed"));

    const res = await metaPost(metaRequest([{ mid: "mid-1", text: "hi" }]));

    expect(res.status).toBeGreaterThanOrEqual(500);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.results[0]).toMatchObject({ ok: false, error: "processing_failed" });
  });

  it("dedupes by mid so the retry is safe: each message is keyed by its own mid", async () => {
    mocks.processInboundMessage
      .mockResolvedValueOnce({ duplicate: false, conversationId: "conv-1" })
      .mockRejectedValueOnce(new Error("transient"));

    const res = await metaPost(
      metaRequest([
        { mid: "mid-a", text: "first" },
        { mid: "mid-b", text: "second" },
      ]),
    );

    expect(res.status).toBe(500);
    const keys = mocks.processInboundMessage.mock.calls.map((c) => {
      const input = c[0] as { idempotencyKey: string; message: { externalId: string } };
      return [input.idempotencyKey, input.message.externalId];
    });
    expect(keys).toEqual([
      ["mid-a", "mid-a"],
      ["mid-b", "mid-b"],
    ]);
  });

  it("keeps 200 when every message succeeded", async () => {
    mocks.processInboundMessage.mockResolvedValue({ duplicate: false, conversationId: "conv-1" });

    const res = await metaPost(metaRequest([{ mid: "mid-1", text: "hi" }]));

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("keeps 200 for intentionally ignored events (unknown Instagram account)", async () => {
    mocks.resolveOrganisationByMetaIgAccountId.mockResolvedValue(null);

    const res = await metaPost(metaRequest([{ mid: "mid-1", text: "hi" }]));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results[0]).toMatchObject({ ignored: true, reason: "unknown_instagram_account" });
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });
});

function manyChatRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/webhooks/manychat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-manychat-secret": "secret" },
    body: JSON.stringify(body),
  }) as never;
}

function lastInput() {
  const calls = mocks.processInboundMessage.mock.calls;
  return calls[calls.length - 1]![0] as {
    idempotencyKey: string;
    message: { externalId?: string };
  };
}

describe("ManyChat webhook idempotency keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveManyChatWebhookOrganisation.mockResolvedValue({
      ok: true,
      organisationId: "org-1",
      channelExternalId: "mc-channel",
      authMethod: "org_scoped_secret",
    });
    mocks.processInboundMessage.mockResolvedValue({ duplicate: false, webhookEventId: "wh-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a second identical 'yes' a few minutes later is a new message, not a duplicate", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:05Z"));
    await manyChatPost(manyChatRequest({ subscriber_id: "sub-1", text: "yes" }));
    const first = lastInput();

    vi.setSystemTime(new Date("2026-11-12T10:03:05Z"));
    await manyChatPost(manyChatRequest({ subscriber_id: "sub-1", text: "yes" }));
    const second = lastInput();

    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.message.externalId).not.toBe(first.message.externalId);
  });

  it("a redelivery within the same minute still dedupes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:05Z"));
    await manyChatPost(manyChatRequest({ subscriber_id: "sub-1", text: "yes" }));
    const first = lastInput();
    vi.setSystemTime(new Date("2026-11-12T10:00:40Z"));
    await manyChatPost(manyChatRequest({ subscriber_id: "sub-1", text: "yes" }));

    expect(lastInput().idempotencyKey).toBe(first.idempotencyKey);
  });

  it("uses the payload timestamp when present", async () => {
    await manyChatPost(
      manyChatRequest({ subscriber_id: "sub-1", text: "ok", timestamp: 1_731_400_000 }),
    );
    const first = lastInput();
    await manyChatPost(
      manyChatRequest({ subscriber_id: "sub-1", text: "ok", timestamp: 1_731_400_010 }),
    );
    const second = lastInput();
    await manyChatPost(
      manyChatRequest({ subscriber_id: "sub-1", text: "ok", timestamp: 1_731_400_010 }),
    );

    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(lastInput().idempotencyKey).toBe(second.idempotencyKey);
  });

  it("prefixes keys with the organisation (WebhookEvent uniqueness spans tenants)", async () => {
    await manyChatPost(manyChatRequest({ subscriber_id: "sub-1", text: "hi", id: "evt-9" }));
    expect(lastInput().idempotencyKey).toBe("org-1:evt-9");
    expect(lastInput().message.externalId).toBe("evt-9");

    mocks.resolveManyChatWebhookOrganisation.mockResolvedValue({
      ok: true,
      organisationId: "org-2",
      authMethod: "org_scoped_secret",
    });
    await manyChatPost(manyChatRequest({ subscriber_id: "sub-1", text: "hi", id: "evt-9" }));
    expect(lastInput().idempotencyKey).toBe("org-2:evt-9");

    await manyChatPost(manyChatRequest({ subscriber_id: "sub-1", text: "hi" }));
    expect(lastInput().idempotencyKey.startsWith("org-2:")).toBe(true);
  });

  it("a failing secret lookup is rejected as 401, never 500", async () => {
    mocks.resolveManyChatWebhookOrganisation.mockRejectedValue(
      new Error("Environment variable not found: DATABASE_URL"),
    );

    const res = await manyChatPost(
      manyChatRequest({ organisationId: "org-1", subscriber_id: "sub-1", text: "hi" }),
    );

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json()).toLowerCase()).toMatch(/secret/);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });
});
