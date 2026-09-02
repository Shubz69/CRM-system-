import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { ZERNIO_SUPPORTED_WEBHOOK_EVENTS } from "@/adapters/zernio/webhook-coverage";

const prismaMocks = vi.hoisted(() => ({
  zernioProfile: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  webhookEvent: {
    findUnique: vi.fn(),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "we_1", ...args.data })),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  message: {
    findFirst: vi.fn(),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: args.where.id,
      ...args.data,
    })),
  },
  conversation: {
    findFirst: vi.fn(),
  },
  socialMetricFact: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "smf_1",
      ...args.data,
    })),
  },
  publishingJob: {
    findFirst: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  domainEvent: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "de_1", ...args.data })),
  },
  contentPiece: {
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMocks)),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));

const appendDomainEvent = vi.hoisted(() => vi.fn(async () => ({ id: "evt" })));
vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: (...args: unknown[]) => appendDomainEvent(...args),
}));

const recordPublishResult = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/services/content-os", () => ({
  recordPublishResult: (...args: unknown[]) => recordPublishResult(...args),
}));

vi.mock("@/services/inbound-pipeline", () => ({
  processInboundMessage: vi.fn(async () => ({
    duplicate: false,
    contactId: "c1",
    conversationId: "conv1",
    messageId: "m1",
  })),
}));

function sign(body: string, secret = "whsec") {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function postWebhook(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const { POST } = await import("@/app/api/webhooks/zernio/route");
  return POST(
    new Request("http://localhost/api/webhooks/zernio", {
      method: "POST",
      headers: { "x-zernio-signature": sign(body) },
      body,
    }) as never,
  );
}

describe("Zernio webhook coverage completion", () => {
  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "zk";
    process.env.ZERNIO_WEBHOOK_SECRET = "whsec";
    process.env.AUTH_SECRET = "auth-secret-for-state-tests-32chars!!";
    resetEnvCache();
    vi.clearAllMocks();
    prismaMocks.zernioProfile.findFirst.mockResolvedValue({ organisationId: "org_1" });
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      connectedAccounts: [{ accountId: "zacc_ig", platform: "instagram" }],
    });
    prismaMocks.webhookEvent.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.ZERNIO_API_KEY;
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    resetEnvCache();
  });

  it("exposes the supported event catalogue", () => {
    expect(ZERNIO_SUPPORTED_WEBHOOK_EVENTS).toEqual(
      expect.arrayContaining([
        "message.edited",
        "message.deleted",
        "reaction.received",
        "referral.received",
        "comment.received",
        "post.published",
        "post.failed",
        "post.partial",
        "post.platform.published",
        "post.platform.failed",
        "post.platform.deleted",
      ]),
    );
  });

  it("message.edited updates tenant-scoped message by external id", async () => {
    prismaMocks.message.findFirst.mockResolvedValue({
      id: "msg_1",
      conversationId: "conv_1",
      organisationId: "org_1",
      body: "old",
      rawPayload: {},
      deliveryStatus: "DELIVERED",
    });
    const res = await postWebhook({
      id: "evt_edit_1",
      event: "message.edited",
      profileId: "zprof_1",
      accountId: "zacc_ig",
      message: { platformMessageId: "mid_1", text: "edited text" },
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "msg_1" },
        data: expect.objectContaining({ body: "edited text" }),
      }),
    );
    expect(appendDomainEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "STATE_CHANGED" }),
    );
  });

  it("message.deleted soft-marks deliveryStatus DELETED without hard delete", async () => {
    prismaMocks.message.findFirst.mockResolvedValue({
      id: "msg_1",
      conversationId: "conv_1",
      organisationId: "org_1",
      body: "keep me",
      rawPayload: {},
      deliveryStatus: "DELIVERED",
    });
    const res = await postWebhook({
      id: "evt_del_1",
      event: "message.deleted",
      profileId: "zprof_1",
      accountId: "zacc_ig",
      message: { platformMessageId: "mid_1" },
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryStatus: "DELETED" }),
      }),
    );
    const updateArg = prismaMocks.message.update.mock.calls[0][0];
    expect(updateArg.data.body).toBeUndefined();
  });

  it("reaction.received attaches to message activity when message exists", async () => {
    prismaMocks.message.findFirst.mockResolvedValue({
      id: "msg_1",
      conversationId: "conv_1",
      organisationId: "org_1",
      body: "hi",
      rawPayload: {},
    });
    const res = await postWebhook({
      id: "evt_react_1",
      event: "reaction.received",
      profileId: "zprof_1",
      accountId: "zacc_ig",
      message: { platformMessageId: "mid_1" },
      reaction: { type: "love" },
      account: { id: "zacc_ig", platform: "instagram" },
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.socialMetricFact.create).toHaveBeenCalled();
    expect(prismaMocks.message.update).toHaveBeenCalled();
    expect(appendDomainEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "CONVERSATION_STATE_CHANGED" }),
    );
  });

  it("referral.received preserves provider referral metadata without inventing leads", async () => {
    const res = await postWebhook({
      id: "evt_ref_1",
      event: "referral.received",
      profileId: "zprof_1",
      accountId: "zacc_ig",
      referral: { ref: "ad_123", source: "instagram_ad" },
      account: { id: "zacc_ig", platform: "instagram" },
    });
    expect(res.status).toBe(200);
    const fact = prismaMocks.socialMetricFact.create.mock.calls[0][0].data;
    expect(fact.metric).toBe("referral_received");
    expect(fact.metadata.referral).toMatchObject({ ref: "ad_123" });
    expect(fact.metadata).not.toHaveProperty("leadId");
  });

  it("comment.received records engagement fact with provenance (no auto-DM)", async () => {
    const res = await postWebhook({
      id: "evt_cmt_1",
      event: "comment.received",
      profileId: "zprof_1",
      accountId: "zacc_ig",
      account: { id: "zacc_ig", platform: "instagram" },
      post: { id: "post_ext_1" },
      comment: {
        id: "cmt_1",
        text: "Nice post",
        createdAt: "2026-09-02T12:00:00.000Z",
        author: { id: "ig_user_9", username: "bob" },
      },
    });
    expect(res.status).toBe(200);
    const fact = prismaMocks.socialMetricFact.create.mock.calls[0][0].data;
    expect(fact.metric).toBe("comment_received");
    expect(fact.externalPostId).toBe("post_ext_1");
    expect(fact.metadata.externalCommentId).toBe("cmt_1");
    expect(fact.metadata.authorExternalId).toBe("ig_user_9");
    expect(fact.metadata.text).toBe("Nice post");
    expect(fact.metadata.provider).toBe("ZERNIO");
  });

  it("post.published confirms via recordPublishResult only with provider IDs", async () => {
    prismaMocks.publishingJob.findFirst.mockResolvedValue({
      id: "job_1",
      organisationId: "org_1",
      status: "PUBLISHING",
      externalOutcome: "PENDING",
      externalPostId: null,
    });
    const res = await postWebhook({
      id: "evt_pub_1",
      event: "post.published",
      profileId: "zprof_1",
      accountId: "zacc_ig",
      metadata: { publishingJobId: "job_1" },
      post: { id: "zpost_1", platformPostId: "ig_media_1", url: "https://instagram.com/p/abc" },
    });
    expect(res.status).toBe(200);
    expect(recordPublishResult).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: "org_1",
        jobId: "job_1",
        externalPostId: "ig_media_1",
        externalUrl: "https://instagram.com/p/abc",
      }),
    );
  });

  it("post.failed records Content OS failure", async () => {
    prismaMocks.publishingJob.findFirst.mockResolvedValue({
      id: "job_1",
      organisationId: "org_1",
      status: "PUBLISHING",
      externalOutcome: "PENDING",
    });
    const res = await postWebhook({
      id: "evt_pub_fail",
      event: "post.failed",
      profileId: "zprof_1",
      metadata: { publishingJobId: "job_1" },
      error: "rate_limited",
    });
    expect(res.status).toBe(200);
    expect(recordPublishResult).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job_1",
        error: "rate_limited",
      }),
    );
  });

  it("post.partial marks reconciliation required", async () => {
    prismaMocks.publishingJob.findFirst.mockResolvedValue({
      id: "job_1",
      organisationId: "org_1",
      status: "PUBLISHING",
      externalOutcome: "PENDING",
    });
    const res = await postWebhook({
      id: "evt_partial",
      event: "post.partial",
      profileId: "zprof_1",
      metadata: { publishingJobId: "job_1" },
      post: { platformPostId: "ig_partial_1" },
    });
    expect(res.status).toBe(200);
    expect(recordPublishResult).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job_1",
        reconciliationRequired: true,
      }),
    );
  });

  it("post.platform.published and post.platform.failed route correctly", async () => {
    prismaMocks.publishingJob.findFirst.mockResolvedValue({
      id: "job_1",
      organisationId: "org_1",
      status: "PUBLISHING",
      externalOutcome: "PENDING",
    });
    const ok = await postWebhook({
      id: "evt_plat_ok",
      event: "post.platform.published",
      profileId: "zprof_1",
      metadata: { publishingJobId: "job_1" },
      platform: { postId: "plat_1", url: "https://x.com/1" },
    });
    expect(ok.status).toBe(200);
    expect(recordPublishResult).toHaveBeenCalledWith(
      expect.objectContaining({ externalPostId: "plat_1" }),
    );

    prismaMocks.webhookEvent.findUnique.mockResolvedValue(null);
    recordPublishResult.mockClear();
    const fail = await postWebhook({
      id: "evt_plat_fail",
      event: "post.platform.failed",
      profileId: "zprof_1",
      metadata: { publishingJobId: "job_1" },
      error: "platform_reject",
    });
    expect(fail.status).toBe(200);
    expect(recordPublishResult).toHaveBeenCalledWith(
      expect.objectContaining({ error: "platform_reject" }),
    );
  });

  it("post.platform.deleted marks reconciliation without inventing success", async () => {
    prismaMocks.publishingJob.findFirst.mockResolvedValue({
      id: "job_1",
      organisationId: "org_1",
      status: "PUBLISHED",
      externalPostId: "plat_1",
      externalOutcome: "CONFIRMED",
    });
    const res = await postWebhook({
      id: "evt_plat_del",
      event: "post.platform.deleted",
      profileId: "zprof_1",
      metadata: { publishingJobId: "job_1" },
      platform: { postId: "plat_1" },
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.publishingJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RECONCILIATION_REQUIRED",
        }),
      }),
    );
  });

  it("duplicate events are idempotent", async () => {
    prismaMocks.webhookEvent.findUnique.mockResolvedValue({
      id: "we_existing",
      status: "PROCESSED",
    });
    const res = await postWebhook({
      id: "evt_dup_cov",
      event: "comment.received",
      profileId: "zprof_1",
      comment: { id: "c", text: "x", author: { id: "a" } },
    });
    const json = await res.json();
    expect(json.duplicate).toBe(true);
    expect(prismaMocks.socialMetricFact.create).not.toHaveBeenCalled();
  });

  it("cross-org isolation: other org message is not updated", async () => {
    prismaMocks.message.findFirst.mockImplementation(async (args: { where: { organisationId: string } }) => {
      if (args.where.organisationId !== "org_1") return null;
      return null; // org_1 also has no matching message for this external id owned elsewhere
    });
    const res = await postWebhook({
      id: "evt_xorg",
      event: "message.edited",
      profileId: "zprof_1",
      accountId: "zacc_ig",
      message: { platformMessageId: "other_org_mid", text: "hack" },
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("message_not_found_for_tenant");
    expect(prismaMocks.message.update).not.toHaveBeenCalled();
  });

  it("unknown event type is acknowledged safely without business mutation", async () => {
    const res = await postWebhook({
      id: "evt_unknown",
      event: "weird.future.event",
      profileId: "zprof_1",
      accountId: "zacc_ig",
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("unknown_event_type");
    expect(prismaMocks.message.update).not.toHaveBeenCalled();
    expect(recordPublishResult).not.toHaveBeenCalled();
  });
});
