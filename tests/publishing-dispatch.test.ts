/**
 * Phase 15 publishing dispatch — unit tests (mocked adapters / prisma).
 * NOT LIVE_E2E.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MissionExternalOutcome,
  PublishingJobStatus,
  SocialConnectionStatus,
  SocialPlatform,
} from "@prisma/client";

const jobFindFirst = vi.fn();
const jobUpdateMany = vi.fn();
const connectionFindFirst = vi.fn();
const assetFindFirst = vi.fn();
const txJobUpdateMany = vi.fn();
const txPieceUpdateMany = vi.fn();
const txAppend = vi.fn();
const contentPieceUpdateMany = vi.fn();
const $transaction = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    publishingJob: {
      findFirst: (...args: unknown[]) => jobFindFirst(...args),
      updateMany: (...args: unknown[]) => jobUpdateMany(...args),
    },
    socialConnection: {
      findFirst: (...args: unknown[]) => connectionFindFirst(...args),
    },
    asset: {
      findFirst: (...args: unknown[]) => assetFindFirst(...args),
    },
    contentPiece: {
      updateMany: (...args: unknown[]) => contentPieceUpdateMany(...args),
    },
    $transaction: (...args: unknown[]) => $transaction(...args),
  },
}));

vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: (...args: unknown[]) => txAppend(...args),
}));

vi.mock("@/adapters/social", () => ({
  getSocialProviderAdapter: vi.fn(() => ({
    platform: SocialPlatform.INSTAGRAM,
    displayName: "Instagram",
    capabilities: { listen: true, publish: true, message: false },
    isConfigured: () => true,
    getAuthorizeUrl: () => "https://example.com",
    exchangeCode: async () => {
      throw new Error("unused");
    },
    publish: async () => ({ ok: false, error: "default mock — override in test" }),
  })),
}));

vi.mock("@/services/social-connections", () => ({
  getConnectionAccessToken: vi.fn(async () => "tok_test"),
}));

vi.mock("@/services/connectors/catalogue", () => ({
  getConnectorDefinition: vi.fn(() => ({
    operations: [{ name: "instagram.publish_post", timeoutMs: 50 }],
  })),
}));

vi.mock("@/services/asset-storage", () => ({
  buildOrgScopedAssetContentUrl: vi.fn(() => ({
    url: "https://app.example.com/api/assets/a1/content?sig=x",
    expiresAt: new Date(),
  })),
}));

import { dispatchPublishingJob } from "@/services/publishing/dispatch";
import { recordPublishResult } from "@/services/content-os";

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    organisationId: "org_1",
    pieceId: "piece_1",
    variantId: null,
    platform: "instagram",
    status: PublishingJobStatus.QUEUED,
    socialConnectionId: "conn_1",
    scheduledAt: null,
    publishedAt: null,
    externalPostId: null,
    externalUrl: null,
    error: null,
    policySnapshot: {},
    externalOutcome: MissionExternalOutcome.PREPARED,
    attemptCount: 0,
    idempotencyKey: null as string | null,
    lastDispatchAt: null,
    confirmedAt: null,
    reconciliationNote: null,
    missionId: null,
    approvalRequestId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    piece: {
      id: "piece_1",
      title: "Hello",
      body: "Caption body",
      status: "APPROVED",
      assetId: null,
      variants: [
        {
          id: "var_1",
          platform: "instagram",
          body: "Caption body",
          metadata: {
            mediaUrl: "https://cdn.example.com/img.jpg",
            mediaType: "IMAGE",
          },
        },
      ],
    },
    ...overrides,
  };
}

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn_1",
    organisationId: "org_1",
    platform: SocialPlatform.INSTAGRAM,
    externalAccountId: "ig_123",
    displayName: "Acme IG",
    status: SocialConnectionStatus.ACTIVE,
    expiresAt: null,
    ...overrides,
  };
}

describe("publishing dispatch (unit — mocked adapters)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobUpdateMany.mockResolvedValue({ count: 1 });
    connectionFindFirst.mockResolvedValue(baseConnection());
    assetFindFirst.mockResolvedValue(null);

    // recordPublishResult / markFailed / markReconciliation use $transaction
    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        publishingJob: {
          updateMany: txJobUpdateMany.mockResolvedValue({ count: 1 }),
          findFirst: jobFindFirst,
        },
        contentPiece: { updateMany: txPieceUpdateMany.mockResolvedValue({ count: 1 }) },
        domainEvent: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      };
      return fn(tx);
    });
    txAppend.mockResolvedValue({});
  });

  it("does not replay a CONFIRMED job (duplicate dispatch)", async () => {
    jobFindFirst.mockResolvedValue(
      baseJob({
        status: PublishingJobStatus.PUBLISHED,
        externalOutcome: MissionExternalOutcome.CONFIRMED,
        externalPostId: "ext_already",
      }),
    );

    const publishOverride = vi.fn(async () => ({ ok: true, externalPostId: "new_id" }));
    const result = await dispatchPublishingJob(
      { organisationId: "org_1", jobId: "job_1" },
      { publishOverride },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claimed).toBe(false);
      expect(result.externalOutcome).toBe(MissionExternalOutcome.CONFIRMED);
      expect(result.externalPostId).toBe("ext_already");
    }
    expect(publishOverride).not.toHaveBeenCalled();
    expect(jobUpdateMany).not.toHaveBeenCalled();
  });

  it("skips dispatch when cancelled before claim", async () => {
    jobFindFirst.mockResolvedValue(
      baseJob({
        status: PublishingJobStatus.CANCELLED,
        externalOutcome: MissionExternalOutcome.PREPARED,
      }),
    );
    const publishOverride = vi.fn(async () => ({ ok: true, externalPostId: "x" }));
    const result = await dispatchPublishingJob(
      { organisationId: "org_1", jobId: "job_1" },
      { publishOverride },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cancelled");
    expect(publishOverride).not.toHaveBeenCalled();
  });

  it("fails clearly when social connection is missing", async () => {
    jobFindFirst.mockResolvedValue(
      baseJob({
        socialConnectionId: null,
        status: PublishingJobStatus.QUEUED,
        externalOutcome: MissionExternalOutcome.PREPARED,
      }),
    );

    const result = await dispatchPublishingJob({
      organisationId: "org_1",
      jobId: "job_1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing_connection");
      expect(result.externalOutcome).toBe(MissionExternalOutcome.FAILED);
    }
  });

  it("marks FAILED on clear provider rejection", async () => {
    jobFindFirst.mockResolvedValue(baseJob());

    const result = await dispatchPublishingJob(
      { organisationId: "org_1", jobId: "job_1" },
      {
        publishOverride: async () => ({ ok: false, error: "Invalid media URL" }),
        getAccessToken: async () => "tok",
        getAdapter: () =>
          ({
            platform: SocialPlatform.INSTAGRAM,
            displayName: "Instagram",
            capabilities: { listen: true, publish: true, message: false },
            isConfigured: () => true,
            getAuthorizeUrl: () => "",
            exchangeCode: async () => {
              throw new Error("n/a");
            },
            publish: async () => ({ ok: false, error: "unused" }),
          }) as never,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("provider_rejected");
      expect(result.externalOutcome).toBe(MissionExternalOutcome.FAILED);
      expect(result.claimed).toBe(true);
    }
  });

  it("marks RECONCILIATION_REQUIRED on provider timeout (never CONFIRMED)", async () => {
    jobFindFirst.mockResolvedValue(baseJob());

    const result = await dispatchPublishingJob(
      { organisationId: "org_1", jobId: "job_1" },
      {
        publishOverride: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { ok: true, externalPostId: "late" };
        },
        getAccessToken: async () => "tok",
        getAdapter: () =>
          ({
            platform: SocialPlatform.INSTAGRAM,
            displayName: "Instagram",
            capabilities: { listen: true, publish: true, message: false },
            isConfigured: () => true,
            getAuthorizeUrl: () => "",
            exchangeCode: async () => {
              throw new Error("n/a");
            },
            publish: async () => ({ ok: true, externalPostId: "x" }),
          }) as never,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("provider_timeout");
      expect(result.externalOutcome).toBe(MissionExternalOutcome.RECONCILIATION_REQUIRED);
    }
  });

  it("confirms only when provider returns externalPostId", async () => {
    jobFindFirst.mockResolvedValue(baseJob());

    const result = await dispatchPublishingJob(
      { organisationId: "org_1", jobId: "job_1" },
      {
        publishOverride: async () => ({ ok: true, externalPostId: "ig_media_99" }),
        getAccessToken: async () => "tok",
        getAdapter: () =>
          ({
            platform: SocialPlatform.INSTAGRAM,
            displayName: "Instagram",
            capabilities: { listen: true, publish: true, message: false },
            isConfigured: () => true,
            getAuthorizeUrl: () => "",
            exchangeCode: async () => {
              throw new Error("n/a");
            },
            publish: async () => ({ ok: true, externalPostId: "ig_media_99" }),
          }) as never,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.externalOutcome).toBe(MissionExternalOutcome.CONFIRMED);
      expect(result.externalPostId).toBe("ig_media_99");
    }
  });

  it("recordPublishResult refuses PUBLISHED without external id/url", async () => {
    jobFindFirst.mockResolvedValue(
      baseJob({
        status: PublishingJobStatus.DISPATCHING,
        externalOutcome: MissionExternalOutcome.DISPATCHING,
      }),
    );
    await expect(
      recordPublishResult({
        organisationId: "org_1",
        jobId: "job_1",
      }),
    ).rejects.toThrow(/externalPostId or externalUrl/i);
  });

  it("cancels duplicate when sibling already CONFIRMED for same idempotencyKey", async () => {
    const key = "publish:org_1:piece_1:instagram:conn_1:default:immediate";
    jobFindFirst
      .mockResolvedValueOnce(baseJob({ idempotencyKey: key }))
      // sibling confirmed lookup
      .mockResolvedValueOnce({ id: "job_older" });

    const publishOverride = vi.fn(async () => ({ ok: true, externalPostId: "x" }));
    const result = await dispatchPublishingJob(
      { organisationId: "org_1", jobId: "job_1" },
      { publishOverride },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("duplicate_idempotency_confirmed");
    expect(publishOverride).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalled();
  });
});
