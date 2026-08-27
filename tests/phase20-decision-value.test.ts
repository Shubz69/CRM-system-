import { beforeEach, describe, expect, it, vi } from "vitest";
import { CounterfactualMaturity } from "@prisma/client";

vi.mock("@/lib/db", () => {
  const mocks = {
    stateSnapshotFindMany: vi.fn(),
    decisionCreate: vi.fn(),
    decisionFindFirst: vi.fn(),
    decisionOutcomeCreate: vi.fn(),
    decisionOutcomeCount: vi.fn(),
    counterfactualCreate: vi.fn(),
  };
  const prisma = {
    stateSnapshot: { findMany: mocks.stateSnapshotFindMany },
    decision: { create: mocks.decisionCreate, findFirst: mocks.decisionFindFirst },
    decisionOutcome: {
      create: mocks.decisionOutcomeCreate,
      count: mocks.decisionOutcomeCount,
    },
    counterfactualRun: { create: mocks.counterfactualCreate },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
    __mocks: mocks,
  };
  return { prisma };
});

import { prisma } from "@/lib/db";
import {
  createDecision,
  DecisionLedgerError,
  recordDecisionOutcome,
} from "@/services/decision-ledger";
import { compareAlternatives, CounterfactualError } from "@/services/counterfactual";

type MockSet = Record<string, ReturnType<typeof vi.fn>>;
const mocks = (prisma as unknown as { __mocks: MockSet }).__mocks;

describe("Phase 20 decision memory and counterfactuals", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.decisionCreate.mockImplementation(async ({ data }) => ({ id: "decision_1", ...data }));
    mocks.counterfactualCreate.mockImplementation(async ({ data }) => ({ id: "run_1", ...data }));
  });

  it("stores alternatives as relational child rows and preserves state references", async () => {
    const asOf = new Date("2026-08-01T00:00:00Z");
    mocks.stateSnapshotFindMany.mockResolvedValue([
      {
        id: "snapshot_1",
        organisationId: "org_a",
        entityType: "Account",
        entityId: "account_1",
        dimension: "health",
        value: "AT_RISK",
        asOf,
      },
    ]);

    await createDecision({
      organisationId: "org_a",
      problemSummary: "Choose retention response",
      decisionType: "RETENTION",
      opportunityId: "opportunity_1",
      alternatives: [
        { alternativeKey: "assist", label: "Assist customer" },
        { alternativeKey: "wait", label: "Wait" },
      ],
      relatedEntities: [{ entityType: "Account", entityId: "account_1" }],
    });

    const data = mocks.decisionCreate.mock.calls[0][0].data;
    expect(data.alternatives.create).toHaveLength(2);
    expect(data.stateRefs.create[0]).toEqual(
      expect.objectContaining({ snapshotId: "snapshot_1", value: "AT_RISK", asOf }),
    );
    // Opportunity is context for the choice, never created as the Decision itself.
    expect(data.opportunityId).toBe("opportunity_1");
    expect(data.opportunity).toBeUndefined();
  });

  it("does not promote correlated attribution or accept unsupported revenue", async () => {
    mocks.decisionFindFirst.mockResolvedValue({ id: "decision_1" });
    mocks.decisionOutcomeCreate.mockImplementation(async ({ data }) => data);
    const correlated = await recordDecisionOutcome({
      organisationId: "org_a",
      decisionId: "decision_1",
      outcomeKind: "RETENTION_SIGNAL",
      attribution: "CORRELATED",
    });
    expect(correlated.attribution).toBe("CORRELATED");

    await expect(
      recordDecisionOutcome({
        organisationId: "org_a",
        decisionId: "decision_1",
        outcomeKind: "REVENUE",
        attribution: "CORRELATED",
        metadata: { revenueCents: 50_000 },
      }),
    ).rejects.toBeInstanceOf(DecisionLedgerError);
  });

  it("keeps historical similarity unavailable with insufficient evidence", async () => {
    mocks.decisionFindFirst.mockResolvedValue({
      id: "decision_1",
      organisationId: "org_a",
      decisionType: "RETENTION",
      goalId: null,
      opportunityId: null,
      alternatives: [],
      evidenceLinks: [],
    });
    mocks.decisionOutcomeCount.mockResolvedValue(2);

    const result = await compareAlternatives({
      organisationId: "org_a",
      decisionId: "decision_1",
      maturity: CounterfactualMaturity.HISTORICAL_SIMILARITY,
    });
    expect(result).toEqual(
      expect.objectContaining({
        capabilityMaturity: "FOUNDATION",
        availability: "UNAVAILABLE",
        insufficientEvidence: true,
      }),
    );
  });

  it("ranks transparently using qualitative value bands, never fake money", async () => {
    mocks.decisionFindFirst.mockResolvedValue({
      id: "decision_1",
      organisationId: "org_a",
      decisionType: "RETENTION",
      goalId: "goal_1",
      opportunityId: null,
      alternatives: [
        {
          id: "alt_a",
          alternativeKey: "a",
          label: "A",
          goalAlignment: 0.9,
          riskBand: "LOW",
          confidenceBand: "HIGH",
          estimatedCostCents: 100,
          potentialValueBand: "HIGH",
          metadata: { evidenceCount: 4 },
        },
        {
          id: "alt_b",
          alternativeKey: "b",
          label: "B",
          goalAlignment: 0.4,
          riskBand: "HIGH",
          confidenceBand: "LOW",
          estimatedCostCents: 300,
          potentialValueBand: null,
          metadata: {},
        },
      ],
      evidenceLinks: [],
    });

    const result = await compareAlternatives({
      organisationId: "org_a",
      decisionId: "decision_1",
    });
    expect(result.ranking[0].alternativeId).toBe("alt_a");
    expect(result.ranking[0].components).toBeDefined();
    expect(result.ranking[0].potentialValueBand).toBe("HIGH");
    expect(result.ranking.every((row) => !("predictedRevenueCents" in row))).toBe(true);
    expect(result.ranking.every((row) => ["LOW", "MEDIUM", "HIGH", "UNKNOWN"].includes(row.potentialValueBand))).toBe(true);
  });

  it("denies cross-organisation decision access", async () => {
    mocks.decisionFindFirst.mockResolvedValue(null);
    await expect(
      compareAlternatives({ organisationId: "org_b", decisionId: "decision_org_a" }),
    ).rejects.toBeInstanceOf(CounterfactualError);
    expect(mocks.decisionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "decision_org_a", organisationId: "org_b" },
      }),
    );
  });
});
