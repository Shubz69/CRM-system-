/**
 * requestPublish rejects social connections from other orgs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentPieceStatus, PublishingJobStatus } from "@prisma/client";

const pieceFindFirst = vi.fn();
const connectionFindFirst = vi.fn();
const jobFindFirst = vi.fn();
const $transaction = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    contentPiece: { findFirst: (...a: unknown[]) => pieceFindFirst(...a), updateMany: vi.fn() },
    socialConnection: { findFirst: (...a: unknown[]) => connectionFindFirst(...a) },
    publishingJob: { findFirst: (...a: unknown[]) => jobFindFirst(...a) },
    $transaction: (...a: unknown[]) => $transaction(...a),
  },
}));

vi.mock("@/kernel", () => ({
  ensureBuiltinToolsRegistered: vi.fn(),
  evaluateToolPolicy: vi.fn(() => ({
    effect: "require_approval",
    reason: "approval required",
  })),
}));

vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: vi.fn(async () => ({ id: "evt_1" })),
}));

import { requestPublish } from "@/services/content-os";

describe("requestPublish — social connection org isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pieceFindFirst.mockResolvedValue({
      id: "piece_1",
      organisationId: "org_a",
      title: "Piece",
      status: ContentPieceStatus.APPROVED,
      whyEvidence: {
        rationale: "Trend cluster evidence",
        researchJobId: "job_1",
        sourceUrls: ["https://example.com"],
      },
    });
    jobFindFirst.mockResolvedValue(null);
  });

  it("rejects a socialConnectionId that is not in the workspace", async () => {
    connectionFindFirst.mockResolvedValue(null);
    await expect(
      requestPublish({
        organisationId: "org_a",
        pieceId: "piece_1",
        platform: "instagram",
        socialConnectionId: "conn_other_org",
      }),
    ).rejects.toThrow(/Social connection not found/i);
    expect(connectionFindFirst).toHaveBeenCalledWith({
      where: {
        id: "conn_other_org",
        organisationId: "org_a",
        status: "ACTIVE",
      },
    });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("queues when connection belongs to the workspace", async () => {
    connectionFindFirst.mockResolvedValue({
      id: "conn_a",
      displayName: "Acme",
      externalAccountId: "ig_1",
      platform: "INSTAGRAM",
      status: "ACTIVE",
    });
    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const created = { id: "job_1", status: PublishingJobStatus.PENDING_APPROVAL };
      const tx = {
        publishingJob: {
          create: vi.fn().mockResolvedValue(created),
          update: vi.fn().mockResolvedValue(created),
        },
        approvalRequest: {
          create: vi.fn().mockResolvedValue({ id: "apr_1" }),
        },
      };
      return fn(tx);
    });

    const result = await requestPublish({
      organisationId: "org_a",
      pieceId: "piece_1",
      platform: "instagram",
      socialConnectionId: "conn_a",
    });
    expect(result.jobId).toBe("job_1");
    expect(result.status).toBe(PublishingJobStatus.PENDING_APPROVAL);
  });
});
