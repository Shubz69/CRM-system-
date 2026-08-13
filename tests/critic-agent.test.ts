import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => {
  const researchJob = {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  };
  const researchFinding = {
    updateMany: vi.fn(),
  };
  return {
    prisma: {
      researchJob,
      researchFinding,
      __mocks: { researchJob, researchFinding },
    },
  };
});

vi.mock("@/services/ai-spend-gate", () => ({
  assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
}));

import { criticAgent } from "@/agents/critic";
import { prisma } from "@/lib/db";

type Mocks = {
  researchJob: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  researchFinding: { updateMany: ReturnType<typeof vi.fn> };
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("critic agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.researchJob.updateMany.mockResolvedValue({ count: 1 });
    mocks.researchFinding.updateMany.mockResolvedValue({ count: 1 });
  });

  it("flags claims whose URL was not collected", async () => {
    mocks.researchJob.findFirst.mockResolvedValue({
      id: "job_1",
      organisationId: "org_a",
      status: "COMPLETED",
      brief: null,
      sources: [{ id: "s1", url: "https://example.com/real" }],
      findings: [
        {
          id: "f1",
          claim: "Real claim",
          researchSourceId: "s1",
          source: { url: "https://example.com/real" },
        },
      ],
    });

    const result = await criticAgent.execute(
      {
        researchJobId: "job_1",
        claims: [
          { claim: "Real claim", sourceUrl: "https://example.com/real" },
          { claim: "Invented statistic: 87% of buyers", sourceUrl: "https://evil.example/fake" },
        ],
      },
      { organisationId: "org_a", agentRunId: "run_1", agentStepId: "step_1" },
    );

    expect(result.output.allCitationsValid).toBe(false);
    expect(result.output.unsupportedClaims).toHaveLength(1);
    expect(result.output.unsupportedClaims[0]?.claim).toMatch(/Invented/);
    expect(mocks.researchJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job_1", organisationId: "org_a" },
      }),
    );
  });

  it("passes when every citation is in the collected set", async () => {
    mocks.researchJob.findFirst.mockResolvedValue({
      id: "job_1",
      organisationId: "org_a",
      status: "COMPLETED",
      brief: null,
      sources: [{ id: "s1", url: "https://example.com/real" }],
      findings: [],
    });

    const result = await criticAgent.execute(
      {
        researchJobId: "job_1",
        claims: [{ claim: "Supported", sourceUrl: "https://example.com/real" }],
      },
      { organisationId: "org_a", agentRunId: "run_1", agentStepId: "step_1" },
    );

    expect(result.output.allCitationsValid).toBe(true);
    expect(result.output.unsupportedClaims).toHaveLength(0);
  });
});
