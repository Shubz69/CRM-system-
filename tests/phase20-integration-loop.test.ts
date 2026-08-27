/**
 * Phase 20 — cross-system loop (mocked DB). Proves L0 + Decision + Counterfactual
 * without LLM spend and without claiming LIVE_E2E.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CounterfactualMaturity } from "@prisma/client";

vi.mock("@/lib/db", () => {
  const mocks = {
    computeAggregateUpsert: vi.fn(async () => ({})),
    computeDecisionCreate: vi.fn(async () => ({})),
    stateSnapshotFindUnique: vi.fn(),
    stateSnapshotUpsert: vi.fn(),
    stateSnapshotFindMany: vi.fn(),
    stateTransitionCreate: vi.fn(async () => ({})),
    stateEvidenceCreateMany: vi.fn(async () => ({ count: 0 })),
    stateDefinitionFindUnique: vi.fn(async () => ({ id: "def_1" })),
    decisionCreate: vi.fn(),
    decisionFindFirst: vi.fn(),
    decisionOutcomeCreate: vi.fn(),
    decisionOutcomeCount: vi.fn(),
    decisionOutcomeFindMany: vi.fn(async () => []),
    counterfactualCreate: vi.fn(),
    costOutcomeFindMany: vi.fn(async () => []),
  };
  const prisma = {
    computeAggregate: { upsert: mocks.computeAggregateUpsert },
    computeDecision: { create: mocks.computeDecisionCreate },
    stateSnapshot: {
      findUnique: mocks.stateSnapshotFindUnique,
      upsert: mocks.stateSnapshotUpsert,
      findMany: mocks.stateSnapshotFindMany,
    },
    stateTransition: { create: mocks.stateTransitionCreate },
    stateEvidenceLink: { createMany: mocks.stateEvidenceCreateMany },
    stateDefinition: { findUnique: mocks.stateDefinitionFindUnique },
    decision: {
      create: mocks.decisionCreate,
      findFirst: mocks.decisionFindFirst,
    },
    decisionOutcome: {
      create: mocks.decisionOutcomeCreate,
      count: mocks.decisionOutcomeCount,
      findMany: mocks.decisionOutcomeFindMany,
    },
    counterfactualRun: { create: mocks.counterfactualCreate },
    costOutcomeLink: { findMany: mocks.costOutcomeFindMany },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
    __mocks: mocks,
  };
  return { prisma };
});

vi.mock("@/services/agent-memory", () => ({
  getOrganisationPreferences: vi.fn(async () => ({})),
  setOrganisationPreference: vi.fn(async () => undefined),
}));

vi.mock("@/services/ai-router", () => ({
  getAiRouterConfig: vi.fn(async () => ({
    taskTiers: { classification: "economy" },
    escalateOnLowConfidence: false,
    lowConfidenceThreshold: 0.55,
    highValueScoreThreshold: 70,
  })),
  selectModelForTask: vi.fn(() => ({
    tier: "economy",
    model: "legacy-cheap",
    reason: "task:classification",
  })),
}));

vi.mock("@/services/ai-spend-gate", () => ({
  assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
  SpendCapExceededError: class SpendCapExceededError extends Error {},
}));

vi.mock("@/services/intelligence-flags", () => ({
  isIntelligenceFlagEnabled: vi.fn(async () => true),
}));

import { prisma } from "@/lib/db";
import { planCompute } from "@/services/compute-governor";
import { applyStateUpdate } from "@/services/business-state";
import { recommendAction, scoreEvidenceDebt } from "@/services/evidence-debt";
import { createDecision } from "@/services/decision-ledger";
import { compareAlternatives } from "@/services/counterfactual";
import { summarizeOrgValue } from "@/services/business-value";

type MockSet = Record<string, ReturnType<typeof vi.fn>>;
const mocks = (prisma as unknown as { __mocks: MockSet }).__mocks;

describe("Phase 20 cross-system integration loop", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.stateSnapshotFindUnique.mockResolvedValue(null);
    mocks.stateSnapshotUpsert.mockResolvedValue({
      id: "snap_1",
      organisationId: "org_1",
      entityType: "DEAL",
      entityId: "deal_1",
      dimension: "URGENCY",
      value: "HIGH",
    });
    mocks.stateSnapshotFindMany.mockResolvedValue([
      {
        id: "snap_1",
        organisationId: "org_1",
        entityType: "DEAL",
        entityId: "deal_1",
        dimension: "URGENCY",
        value: "HIGH",
        asOf: new Date("2026-08-01T00:00:00Z"),
      },
    ]);
    mocks.decisionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "decision_1",
      ...data,
      alternatives: data.alternatives,
    }));
    mocks.counterfactualCreate.mockImplementation(async ({ data }: { data: unknown }) => ({
      id: "cf_1",
      ...(data as object),
    }));
    mocks.decisionOutcomeCount.mockResolvedValue(0);
    mocks.decisionOutcomeFindMany.mockResolvedValue([]);
    mocks.costOutcomeFindMany.mockResolvedValue([]);
  });

  it("runs L0 → state → debt scoring → decision → evidence comparison without LLM", async () => {
    const compute = await planCompute({
      organisationId: "org_1",
      taskType: "classification",
      evidenceState: { deterministicCapable: true },
      complexity: "LOW",
      consequence: "LOW",
    });
    expect(compute.governorMode).toBe("DETERMINISTIC");
    expect(compute.reasonCodes.some((r) => r.startsWith("L0_"))).toBe(true);

    const state = await applyStateUpdate({
      organisationId: "org_1",
      entityType: "DEAL",
      entityId: "deal_1",
      dimension: "URGENCY",
      value: "HIGH",
      reasonCode: "INACTIVITY",
      evidenceLinks: [{ evidenceKind: "DomainEvent", evidenceId: "evt_1" }],
    });
    expect(state.changed).toBe(true);

    const priority = scoreEvidenceDebt({
      importance: "HIGH",
      freshnessBand: "STALE",
      confidenceBand: "LOW",
      independentSources: 1,
      goalDependencyCount: 2,
      opportunityDependencyCount: 1,
      consequenceBand: "HIGH",
    });
    expect(priority).toBeGreaterThan(50);
    expect(recommendAction({ priorityScore: priority, consequenceBand: "HIGH" })).not.toBe(
      "none",
    );
    // Never auto-launches deep research — actions are recommendations only.
    expect([
      "recommend_refresh",
      "create_research_opportunity",
      "request_human",
      "schedule_cheap_refresh",
      "none",
    ]).toContain(recommendAction({ priorityScore: priority, consequenceBand: "HIGH" }));

    const decision = await createDecision({
      organisationId: "org_1",
      problemSummary: "Increase qualified pipeline",
      decisionType: "GROWTH_LEVER",
      goalId: "goal_1",
      opportunityId: "opp_1",
      relatedEntities: [{ entityType: "DEAL", entityId: "deal_1" }],
      alternatives: [
        {
          alternativeKey: "reactivate",
          label: "Reactivate qualified leads",
          potentialValueBand: "MEDIUM",
          riskBand: "LOW",
          confidenceBand: "MEDIUM",
          goalAlignment: 0.8,
          metadata: { evidenceCount: 3 },
        },
        {
          alternativeKey: "linkedin",
          label: "Increase LinkedIn activity",
          potentialValueBand: "MEDIUM",
          riskBand: "MEDIUM",
          confidenceBand: "LOW",
          goalAlignment: 0.6,
          metadata: { evidenceCount: 1 },
        },
      ],
    });
    expect(decision.id).toBe("decision_1");
    expect(mocks.decisionCreate).toHaveBeenCalled();

    mocks.decisionFindFirst.mockResolvedValue({
      id: "decision_1",
      organisationId: "org_1",
      goalId: "goal_1",
      opportunityId: "opp_1",
      decisionType: "GROWTH_LEVER",
      alternatives: [
        {
          id: "alt_1",
          alternativeKey: "reactivate",
          label: "Reactivate",
          riskBand: "LOW",
          confidenceBand: "MEDIUM",
          goalAlignment: 0.8,
          estimatedCostCents: 100,
          potentialValueBand: "MEDIUM",
          metadata: { evidenceCount: 3 },
        },
        {
          id: "alt_2",
          alternativeKey: "linkedin",
          label: "LinkedIn",
          riskBand: "MEDIUM",
          confidenceBand: "LOW",
          goalAlignment: 0.6,
          estimatedCostCents: 500,
          potentialValueBand: "MEDIUM",
          metadata: { evidenceCount: 1 },
        },
      ],
      evidenceLinks: [],
    });

    const cf = await compareAlternatives({
      organisationId: "org_1",
      decisionId: "decision_1",
      maturity: CounterfactualMaturity.EVIDENCE_COMPARISON,
    });
    expect(cf.insufficientEvidence).toBe(false);
    expect(cf.ranking.length).toBe(2);
    expect(JSON.stringify(cf)).not.toMatch(/guaranteed revenue|£\d{2,}/i);

    const value = await summarizeOrgValue({
      organisationId: "org_1",
      since: new Date("2020-01-01T00:00:00Z"),
    });
    expect(value.valueStatus).toBe("UNKNOWN");
  });
});
