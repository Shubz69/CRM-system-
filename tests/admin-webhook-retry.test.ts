import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  webhookEventFindUnique: vi.fn(),
  webhookEventUpdate: vi.fn(),
  messagingChannelFindFirst: vi.fn(),
  processInboundMessage: vi.fn(),
  writeAuditLog: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhookEvent: {
      findUnique: mocks.webhookEventFindUnique,
      update: mocks.webhookEventUpdate,
    },
    messagingChannel: { findFirst: mocks.messagingChannelFindFirst },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/session", () => ({
  requirePlatformAccess: vi.fn(async () => ({ userId: "admin_1", organisationId: "org_platform" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));
vi.mock("@/services/audit", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/services/usage", () => ({ recordUsage: mocks.recordUsage }));
vi.mock("@/services/inbound-pipeline", () => ({
  processInboundMessage: (...args: unknown[]) => mocks.processInboundMessage(...args),
}));

import { POST } from "@/app/api/admin/webhooks/retry/route";

const ORG = "org_salon";
const DIGEST = "a".repeat(64);

function failedManyChatEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    provider: "manychat",
    eventType: "inbound_message",
    organisationId: ORG,
    idempotencyKey: `${ORG}:${DIGEST}`,
    status: "FAILED",
    error: "Transaction already closed",
    // Exactly what /api/webhooks/manychat stores: the raw ManyChat body.
    payload: {
      subscriber_id: 12345,
      first_name: "Ada",
      last_name: "Lovelace",
      ig_username: "ada_l",
      text: "How much is a cut?",
      timestamp: "2026-11-15T10:00:00.000Z",
    },
    ...overrides,
  };
}

function retry(webhookEventId = "evt_1") {
  return POST(
    new Request("http://localhost/api/admin/webhooks/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhookEventId }),
    }) as never,
  );
}

describe("admin webhook retry replays the stored event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.messagingChannelFindFirst.mockResolvedValue({ externalId: "mc_channel_1" });
    mocks.webhookEventUpdate.mockResolvedValue({ status: "PROCESSED", error: null });
  });

  it("replays a failed ManyChat event through the inbound pipeline with the webhook's own keys", async () => {
    mocks.webhookEventFindUnique
      .mockResolvedValueOnce(failedManyChatEvent())
      .mockResolvedValueOnce({ status: "PROCESSED", error: "Transaction already closed" });
    mocks.processInboundMessage.mockResolvedValue({ duplicate: false, webhookEventId: "evt_1" });

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "PROCESSED" });
    expect(mocks.processInboundMessage).toHaveBeenCalledWith(
      {
        organisationId: ORG,
        channelExternalId: "mc_channel_1",
        idempotencyKey: `${ORG}:${DIGEST}`,
        contact: {
          externalId: "12345",
          fullName: "Ada Lovelace",
          instagramUsername: "ada_l",
          email: undefined,
          phone: undefined,
        },
        message: { text: "How much is a cut?", externalId: `mc_${DIGEST.slice(0, 32)}` },
        threadId: undefined,
        campaignSource: undefined,
        leadSource: "instagram_manychat",
      },
      // Same provider + key: the pipeline reprocesses the stored row in place.
      { provider: "manychat", rawPayload: failedManyChatEvent().payload },
    );
    // Stale failure text cleared; the event is never marked IGNORED.
    expect(mocks.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "evt_1" }, data: { error: null } }),
    );
    for (const call of mocks.webhookEventUpdate.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("IGNORED");
    }
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "webhook.retry", entityId: "evt_1" }),
    );
  });

  it("uses the ManyChat message id and channel_id when the payload carries them", async () => {
    const event = failedManyChatEvent({
      idempotencyKey: `${ORG}:mc_msg_9`,
      payload: { id: "mc_msg_9", channel_id: "chan_7", subscriber_id: "s1", message: "hi" },
    });
    mocks.webhookEventFindUnique
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce({ status: "PROCESSED", error: null });
    mocks.processInboundMessage.mockResolvedValue({ duplicate: false, webhookEventId: "evt_1" });

    const res = await retry();

    expect(res.status).toBe(200);
    const [input] = mocks.processInboundMessage.mock.calls[0]!;
    expect(input).toMatchObject({
      channelExternalId: "chan_7",
      idempotencyKey: `${ORG}:mc_msg_9`,
      message: { text: "hi", externalId: "mc_msg_9" },
    });
    expect(mocks.messagingChannelFindFirst).not.toHaveBeenCalled();
  });

  it("leaves the event FAILED and explains when the replay itself fails", async () => {
    mocks.webhookEventFindUnique
      .mockResolvedValueOnce(failedManyChatEvent())
      .mockResolvedValueOnce({ status: "FAILED", error: "Transaction already closed" });
    mocks.processInboundMessage.mockRejectedValue(new Error("Transaction already closed"));

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.status).toBe("FAILED");
    expect(json.error).toMatch(/still marked failed/i);
    expect(mocks.webhookEventUpdate).not.toHaveBeenCalled();
  });

  it("refuses providers it can't replay without touching the event", async () => {
    mocks.webhookEventFindUnique.mockResolvedValueOnce(
      failedManyChatEvent({ provider: "meta_instagram", payload: { recipientId: "ig_1" } }),
    );

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.error).toMatch(/can't be replayed/i);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
    expect(mocks.webhookEventUpdate).not.toHaveBeenCalled();
  });

  it("refuses a ManyChat payload with no message instead of marking it IGNORED", async () => {
    mocks.webhookEventFindUnique.mockResolvedValueOnce(
      failedManyChatEvent({ payload: { subscriber_id: "s1" } }),
    );

    const res = await retry();

    expect(res.status).toBe(422);
    expect(mocks.webhookEventUpdate).not.toHaveBeenCalled();
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });

  it("recovers events the old retry wrongly marked IGNORED", async () => {
    mocks.webhookEventFindUnique
      .mockResolvedValueOnce(
        failedManyChatEvent({
          status: "IGNORED",
          error: "Payload is not a retriable inbound message shape",
        }),
      )
      .mockResolvedValueOnce({ status: "PROCESSED", error: null });
    mocks.processInboundMessage.mockResolvedValue({ duplicate: false, webhookEventId: "evt_1" });

    const res = await retry();

    expect(res.status).toBe(200);
    expect(mocks.processInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("does not replay events ignored for other reasons", async () => {
    mocks.webhookEventFindUnique.mockResolvedValueOnce(
      failedManyChatEvent({ status: "IGNORED", error: "Workspace suspended" }),
    );

    const res = await retry();

    expect(res.status).toBe(409);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });

  it("won't replay an event that is still being processed", async () => {
    mocks.webhookEventFindUnique.mockResolvedValueOnce(
      failedManyChatEvent({ status: "PROCESSING", error: null, createdAt: new Date() }),
    );

    const res = await retry();

    expect(res.status).toBe(409);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });

  it("replays an event abandoned in PROCESSING by a crashed request", async () => {
    mocks.webhookEventFindUnique
      .mockResolvedValueOnce(
        failedManyChatEvent({
          status: "PROCESSING",
          error: null,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
        }),
      )
      .mockResolvedValueOnce({ status: "PROCESSED", error: null });
    mocks.processInboundMessage.mockResolvedValueOnce({ duplicate: false, webhookEventId: "evt_1" });

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "PROCESSED" });
    expect(mocks.processInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("treats processed events as already done", async () => {
    mocks.webhookEventFindUnique.mockResolvedValueOnce(
      failedManyChatEvent({ status: "PROCESSED", error: null }),
    );

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, duplicate: true });
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });
});
