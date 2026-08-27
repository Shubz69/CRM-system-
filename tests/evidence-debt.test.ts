import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flagEnabled: vi.fn(),
  upsertDebt: vi.fn(),
  updateDebt: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    evidenceDebtItem: {
      upsert: mocks.upsertDebt,
      updateMany: mocks.updateDebt,
    },
  },
}));

vi.mock("@/services/intelligence-flags", () => ({
  isIntelligenceFlagEnabled: mocks.flagEnabled,
}));

import {
  recommendAction,
  scoreEvidenceDebt,
  upsertEvidenceDebtItem,
} from "@/services/evidence-debt";

describe("evidence debt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flagEnabled.mockResolvedValue(true);
    mocks.upsertDebt.mockImplementation(async ({ create }) => ({ id: "debt-1", ...create }));
  });

  it("gives low-value stale evidence less priority than high-value stale evidence", () => {
    const low = scoreEvidenceDebt({
      importance: "LOW",
      freshnessBand: "STALE",
      confidenceBand: "LOW",
      independentSources: 0,
    });
    const high = scoreEvidenceDebt({
      importance: "HIGH",
      freshnessBand: "STALE",
      confidenceBand: "LOW",
      independentSources: 0,
    });
    expect(low).toBeLessThan(high);
  });

  it("only recommends a next action and never launches deep research", async () => {
    const action = recommendAction({
      importance: "HIGH",
      freshnessBand: "STALE",
      confidenceBand: "LOW",
      independentSources: 0,
      goalDependencyCount: 2,
    });
    expect([
      "recommend_refresh",
      "create_research_opportunity",
      "request_human",
      "schedule_cheap_refresh",
      "none",
    ]).toContain(action);

    await upsertEvidenceDebtItem({
      organisationId: "org-a",
      subjectKind: "CLAIM",
      subjectId: "claim-1",
      title: "Validate pipeline claim",
      importance: "HIGH",
      freshnessBand: "STALE",
      confidenceBand: "LOW",
      independentSources: 0,
      goalDependencyCount: 2,
    });

    expect(mocks.upsertDebt).toHaveBeenCalledOnce();
    expect(mocks.upsertDebt.mock.calls[0]?.[0].create).not.toHaveProperty("researchJobId");
  });

  it("does not persist debt when the intelligence flag is disabled", async () => {
    mocks.flagEnabled.mockResolvedValue(false);
    const result = await upsertEvidenceDebtItem({
      organisationId: "org-a",
      subjectKind: "CLAIM",
      subjectId: "claim-2",
      title: "Disabled debt",
    });
    expect(result).toBeNull();
    expect(mocks.upsertDebt).not.toHaveBeenCalled();
  });
});
