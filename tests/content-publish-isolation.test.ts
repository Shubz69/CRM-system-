/**
 * requestPublish rejects social connections from other orgs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentPieceStatus } from "@prisma/client";

vi.mock("@/lib/db", () => {
  const pieceFindFirst = vi.fn();
  const connectionFindFirst = vi.fn();
  const jobCreate = vi.fn();
  return {
    prisma: {
      contentPiece: { findFirst: pieceFindFirst },
      socialConnection: { findFirst: connectionFindFirst },
      publishingJob: { create: jobCreate },
      __mocks: { pieceFindFirst, connectionFindFirst, jobCreate },
    },
  };
});

vi.mock("@/kernel", () => ({
  ensureBuiltinToolsRegistered: vi.fn(),
  evaluateToolPolicy: vi.fn(() => ({
    effect: "require_approval",
    reason: "approval required",
  })),
}));

import { requestPublish } from "@/services/content-os";
import { prisma } from "@/lib/db";

type Mocks = {
  pieceFindFirst: ReturnType<typeof vi.fn>;
  connectionFindFirst: ReturnType<typeof vi.fn>;
  jobCreate: ReturnType<typeof vi.fn>;
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("requestPublish — social connection org isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pieceFindFirst.mockResolvedValue({
      id: "piece_1",
      organisationId: "org_a",
      status: ContentPieceStatus.APPROVED,
      whyEvidence: {
        rationale: "Trend cluster evidence",
        researchJobId: "job_1",
        sourceUrls: ["https://example.com"],
      },
    });
  });

  it("rejects a socialConnectionId that is not in the workspace", async () => {
    mocks.connectionFindFirst.mockResolvedValue(null);
    await expect(
      requestPublish({
        organisationId: "org_a",
        pieceId: "piece_1",
        platform: "instagram",
        socialConnectionId: "conn_other_org",
      }),
    ).rejects.toThrow(/Social connection not found/i);
    expect(mocks.connectionFindFirst).toHaveBeenCalledWith({
      where: { id: "conn_other_org", organisationId: "org_a" },
      select: { id: true },
    });
    expect(mocks.jobCreate).not.toHaveBeenCalled();
  });

  it("queues when connection belongs to the workspace", async () => {
    mocks.connectionFindFirst.mockResolvedValue({ id: "conn_a" });
    mocks.jobCreate.mockResolvedValue({
      id: "job_1",
      status: "PENDING_APPROVAL",
    });
    const result = await requestPublish({
      organisationId: "org_a",
      pieceId: "piece_1",
      platform: "instagram",
      socialConnectionId: "conn_a",
    });
    expect(result.jobId).toBe("job_1");
    expect(mocks.jobCreate).toHaveBeenCalled();
  });
});
