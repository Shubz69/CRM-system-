import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => {
  const findUnique = vi.fn();
  const aggregate = vi.fn();
  const upsert = vi.fn();
  const groupBy = vi.fn();
  const count = vi.fn();
  return {
    prisma: {
      organisationAiBudget: { findUnique, upsert },
      aiExecution: { aggregate, groupBy, count },
      __mocks: { findUnique, aggregate, upsert, groupBy, count },
    },
  };
});

import {
  assertWithinSpendCap,
  getOrganisationSpendBreakdown,
  SpendCapExceededError,
  setOrganisationAiBudget,
} from "@/services/ai-spend-gate";
import { prisma } from "@/lib/db";

type Mocks = {
  findUnique: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("AI spend gate (unit)", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
    mocks.aggregate.mockReset();
    mocks.upsert.mockReset();
    mocks.groupBy.mockReset();
    mocks.count.mockReset();
  });

  it("allows when no cap is configured (preserves sales-path behaviour)", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const result = await assertWithinSpendCap("org_a");
    expect(result.ok).toBe(true);
    expect(result.capCents).toBeNull();
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("blocks when period spend exceeds cap", async () => {
    mocks.findUnique.mockResolvedValue({
      organisationId: "org_a",
      monthlyCapCents: 100,
    });
    mocks.aggregate.mockResolvedValue({ _sum: { estimatedCost: 2.5 } }); // $2.50 = 250¢

    await expect(assertWithinSpendCap("org_a")).rejects.toBeInstanceOf(SpendCapExceededError);
  });

  it("allows when under cap", async () => {
    mocks.findUnique.mockResolvedValue({
      organisationId: "org_a",
      monthlyCapCents: 1000,
    });
    mocks.aggregate.mockResolvedValue({ _sum: { estimatedCost: 1.0 } }); // 100¢

    const result = await assertWithinSpendCap("org_a", 50);
    expect(result.ok).toBe(true);
    expect(result.spentCents).toBe(100);
    expect(result.capCents).toBe(1000);
  });

  it("setOrganisationAiBudget is org-scoped via organisationId", async () => {
    mocks.upsert.mockResolvedValue({
      organisationId: "org_a",
      monthlyCapCents: 500,
    });
    await setOrganisationAiBudget({ organisationId: "org_a", monthlyCapCents: 500 });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organisationId: "org_a" },
        create: expect.objectContaining({ organisationId: "org_a" }),
      }),
    );
  });

  it("spend breakdown uses ledger groupBy and omits null costs", async () => {
    mocks.groupBy.mockResolvedValue([
      {
        provider: "anthropic",
        model: "claude",
        taskType: "research",
        _sum: { estimatedCost: 1.25 },
        _count: { _all: 3 },
      },
    ]);
    mocks.count.mockResolvedValue(2); // null-cost rows

    const breakdown = await getOrganisationSpendBreakdown("org_a");
    expect(mocks.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organisationId: "org_a",
          estimatedCost: { not: null },
        }),
      }),
    );
    expect(breakdown.rows).toHaveLength(1);
    expect(breakdown.rows[0]?.estimatedCostCents).toBe(125);
    expect(breakdown.omittedNullCostCount).toBe(2);
    expect(breakdown.totalCents).toBe(125);
    expect(breakdown.message).toMatch(/omitted/i);
  });

  it("spend breakdown stays empty when no priced executions", async () => {
    mocks.groupBy.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    const breakdown = await getOrganisationSpendBreakdown("org_a");
    expect(breakdown.rows).toEqual([]);
    expect(breakdown.totalCents).toBe(0);
    expect(breakdown.message).toMatch(/hidden/i);
  });
});
