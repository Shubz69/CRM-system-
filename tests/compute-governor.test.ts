import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    computeAggregate: { upsert: vi.fn(async () => ({})) },
    computeDecision: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("@/services/agent-memory", () => ({
  getOrganisationPreferences: vi.fn(async () => ({})),
  setOrganisationPreference: vi.fn(async () => undefined),
}));

vi.mock("@/services/ai-router", () => ({
  getAiRouterConfig: vi.fn(async () => ({
    taskTiers: { classification: "economy", conversation: "default" },
    escalateOnLowConfidence: true,
    lowConfidenceThreshold: 0.55,
    highValueScoreThreshold: 70,
  })),
  selectModelForTask: vi.fn(({ taskType }: { taskType: string }) =>
    taskType === "classification"
      ? { tier: "economy", model: "legacy-cheap", reason: "task:classification" }
      : { tier: "default", model: "legacy-standard", reason: "task:conversation" },
  ),
}));

vi.mock("@/services/ai-spend-gate", () => {
  class SpendCapExceededError extends Error {
    readonly code = "SPEND_CAP_EXCEEDED";
    constructor(
      message: string,
      readonly organisationId: string,
      readonly spentCents: number,
      readonly capCents: number,
    ) {
      super(message);
      this.name = "SpendCapExceededError";
    }
  }
  return {
    SpendCapExceededError,
    assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
  };
});

import { prisma } from "@/lib/db";
import { getOrganisationPreferences } from "@/services/agent-memory";
import {
  assertWithinSpendCap,
  SpendCapExceededError,
} from "@/services/ai-spend-gate";
import {
  planCompute,
  resolveActiveComputePlan,
} from "@/services/compute-governor";

describe("Phase 20A compute governor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COMPUTE_GOVERNOR_SHADOW_ONLY;
    vi.mocked(getOrganisationPreferences).mockResolvedValue({});
    vi.mocked(assertWithinSpendCap).mockResolvedValue({
      ok: true,
      spentCents: 0,
      capCents: null,
    });
  });

  it("uses L0 evidence while a missing enable preference defaults true", async () => {
    const plan = await planCompute({
      organisationId: "org_1",
      taskType: "classification",
      evidenceState: { hasVerifiedClaim: true },
    });

    expect(plan.governorMode).toBe("DETERMINISTIC");
    expect(plan.reasonCodes).toContain("L0_VERIFIED_CLAIM");
    expect(prisma.computeAggregate.upsert).toHaveBeenCalledOnce();
    expect(assertWithinSpendCap).not.toHaveBeenCalled();
  });

  it("records and rethrows a spend-cap hard stop", async () => {
    vi.mocked(assertWithinSpendCap).mockRejectedValueOnce(
      new SpendCapExceededError("cap reached", "org_1", 100, 100),
    );

    await expect(
      planCompute({
        organisationId: "org_1",
        taskType: "conversation",
        complexity: "HIGH",
      }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(prisma.computeDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorSummary: "cap reached",
          reasonCodes: expect.arrayContaining(["SPEND_CAP_DENIED"]),
        }),
      }),
    );
  });

  it("exposes shadow fields and resolves the legacy production model", async () => {
    const plan = await planCompute({
      organisationId: "org_1",
      taskType: "conversation",
      complexity: "CRITICAL",
    });
    const active = await resolveActiveComputePlan(plan);

    expect(plan.shadowOnly).toBe(true);
    expect(plan.governorMode).toBe("DEEP");
    expect(plan.activeMode).toBe("STANDARD");
    expect(active.selectedModel).toBe("legacy-standard");
    expect(plan.legacySelection.tier).toBe("default");
  });
});
