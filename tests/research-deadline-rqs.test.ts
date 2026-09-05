/**
 * Round 7D — research deadline / RQS attach fixtures (A–F).
 * Proves mandatory RQS before optional enrichment, and PARTIAL retains quality.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ANALYST_SAFE_BUDGET_MS,
  CRITIC_SAFE_BUDGET_MS,
  RQS_RESERVE_MS,
  remainingWallClockMs,
  shouldSkipOptionalEnrichment,
} from "@/agents/supervisor/research-deadline";

const agentRunFindFirst = vi.fn();
const agentRunUpdateMany = vi.fn(async () => ({ count: 1 }));
const agentStepCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: `step_${String(args.data.position)}`,
  ...args.data,
}));
const agentStepUpdateMany = vi.fn(async () => ({ count: 1 }));
const organisationFindFirst = vi.fn(async () => ({ id: "org_a", name: "Demo" }));
const limitsFindUnique = vi.fn(async () => null);

vi.mock("@/lib/db", () => ({
  prisma: {
    agentRun: {
      findFirst: (...a: unknown[]) => agentRunFindFirst(...a),
      updateMany: (...a: unknown[]) => agentRunUpdateMany(...a),
    },
    agentStep: {
      create: (...a: unknown[]) => agentStepCreate(...a),
      updateMany: (...a: unknown[]) => agentStepUpdateMany(...a),
    },
    organisation: {
      findFirst: (...a: unknown[]) => organisationFindFirst(...a),
    },
    organisationAgentLimits: {
      findUnique: (...a: unknown[]) => limitsFindUnique(...a),
    },
  },
}));

vi.mock("@/services/ai-spend-gate", () => {
  class SpendCapExceededError extends Error {
    code = "SPEND_CAP_EXCEEDED";
    constructor(
      message: string,
      public organisationId: string,
      public spentCents: number,
      public capCents: number,
    ) {
      super(message);
      this.name = "SpendCapExceededError";
    }
  }
  return {
    assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
    SpendCapExceededError,
  };
});

const scoreResearchQualityMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/research-quality", async () => {
  const actual = await vi.importActual<typeof import("@/services/research-quality")>(
    "@/services/research-quality",
  );
  return {
    ...actual,
    scoreResearchQuality: (...args: unknown[]) => scoreResearchQualityMock(...args),
  };
});

import { executeAgentRun } from "@/agents/supervisor/execute";
import { registerAgent, resetAgentBootstrap } from "@/agents";
import type { Agent } from "@/agents/types";

const ICO = "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/";
const GOV = "https://www.gov.uk/data-protection";

function groundedResearchOutput() {
  return {
    researchJobId: "job_deadline_1",
    topic: "UK GDPR CRM contact storage",
    summary: "Grounded UK GDPR CRM storage overview.",
    shortAnswer: "Controllers need a lawful basis to store CRM contacts.",
    findings: [
      {
        claim: "UK GDPR requires a lawful basis to process personal data in a CRM.",
        sourceUrl: ICO,
        evidenceExcerpt: "You must have a lawful basis under UK GDPR.",
        claimKind: "OFFICIAL" as const,
        confidence: 0.9,
      },
      {
        claim: "Personal data must not be kept longer than necessary.",
        sourceUrl: GOV,
        evidenceExcerpt: "Storage limitation principle applies.",
        claimKind: "OFFICIAL" as const,
        confidence: 0.88,
      },
    ],
    sources: [
      { url: ICO, title: "ICO UK GDPR", platform: "web" },
      { url: GOV, title: "GOV.UK data protection", platform: "web" },
    ],
  };
}

const passthrough = z.record(z.string(), z.unknown());

function makeAgent(input: {
  name: string;
  label: string;
  execute: Agent["execute"];
  delayMs?: number;
}): Agent {
  return {
    name: input.name,
    description: input.name,
    inputSchema: passthrough,
    outputSchema: passthrough,
    tier: "cheap",
    estimateCostCents: () => 0,
    userFacingLabel: () => input.label,
    async execute(args, ctx) {
      if (input.delayMs) {
        await new Promise((r) => setTimeout(r, input.delayMs));
      }
      return input.execute(args, ctx);
    },
  };
}

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_deadline",
    organisationId: "org_a",
    userId: "user_1",
    triggeredBy: "user",
    request:
      "Research the current UK GDPR requirements for storing customer contact details in a CRM. Prioritise authoritative UK sources.",
    plan: {
      steps: [
        { agentName: "research", input: { topic: "UK GDPR CRM" } },
        { agentName: "analyst", input: { topic: "UK GDPR CRM" } },
        { agentName: "critic", input: {} },
      ],
      plainEnglishPlan: "Research then enrich.",
    },
    plainEnglishPlan: "Research then enrich.",
    clarificationQuestion: null,
    clarificationOptions: null,
    status: "PENDING",
    startedAt: null,
    finishedAt: null,
    totalCostCents: 0,
    error: null,
    userFacingError: null,
    partialResults: null,
    finalOutput: null,
    answerMode: "DEEP",
    maxSteps: 8,
    maxWallClockSeconds: 600,
    maxSpendCents: null,
    bullJobId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function useRealScorer() {
  const actual = await vi.importActual<typeof import("@/services/research-quality")>(
    "@/services/research-quality",
  );
  scoreResearchQualityMock.mockImplementation((input) =>
    actual.scoreResearchQuality(input as never),
  );
}

function registerPipeline(agents: {
  research: Parameters<typeof makeAgent>[0];
  analyst: Parameters<typeof makeAgent>[0];
  critic: Parameters<typeof makeAgent>[0];
}) {
  resetAgentBootstrap();
  registerAgent(makeAgent(agents.research));
  registerAgent(makeAgent(agents.analyst));
  registerAgent(makeAgent(agents.critic));
}

describe("research deadline helpers", () => {
  it("skips optional enrichment when remaining budget is below safe + RQS reserve", () => {
    expect(
      shouldSkipOptionalEnrichment({
        agentName: "analyst",
        remainingMs: ANALYST_SAFE_BUDGET_MS + RQS_RESERVE_MS - 1,
      }),
    ).toBe(true);
    expect(
      shouldSkipOptionalEnrichment({
        agentName: "analyst",
        remainingMs: ANALYST_SAFE_BUDGET_MS + RQS_RESERVE_MS,
      }),
    ).toBe(false);
    expect(
      shouldSkipOptionalEnrichment({
        agentName: "critic",
        remainingMs: CRITIC_SAFE_BUDGET_MS,
      }),
    ).toBe(true);
    expect(shouldSkipOptionalEnrichment({ agentName: "research", remainingMs: 1 })).toBe(false);
  });

  it("computes remaining wall-clock from startedAt", () => {
    const startedAt = new Date(Date.now() - 100_000);
    const remaining = remainingWallClockMs({
      startedAt,
      maxWallClockSeconds: 120,
    });
    expect(remaining).toBeGreaterThan(15_000);
    expect(remaining).toBeLessThan(25_000);
  });
});

describe("research deadline / RQS attach (Round 7D A–F)", () => {
  beforeEach(() => {
    agentRunFindFirst.mockReset();
    agentRunUpdateMany.mockClear();
    agentStepCreate.mockClear();
    agentStepUpdateMany.mockClear();
    scoreResearchQualityMock.mockReset();
  });

  it("A: grounding completes with ample time → RQS attaches", async () => {
    await useRealScorer();
    registerPipeline({
      research: {
        name: "research",
        label: "Gathering evidence",
        execute: async () => ({ output: groundedResearchOutput(), costCents: 0 }),
      },
      analyst: {
        name: "analyst",
        label: "Preparing your answer",
        execute: async () => ({
          output: {
            ...groundedResearchOutput(),
            claims: groundedResearchOutput().findings,
            brief: "Enriched brief",
          },
          costCents: 0,
        }),
      },
      critic: {
        name: "critic",
        label: "Checking sources",
        execute: async () => ({
          output: { summary: "Citations look consistent.", ok: true },
          costCents: 0,
        }),
      },
    });

    agentRunFindFirst.mockResolvedValue(baseRun({ maxWallClockSeconds: 600 }));
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_deadline" });
    expect(result.status).toBe("COMPLETED");
    const fo = result.finalOutput as Record<string, unknown>;
    expect(fo.researchQuality).toBeTruthy();
    expect(
      (fo.researchQuality as { claimConfidences?: unknown[] }).claimConfidences?.length,
    ).toBeGreaterThan(0);
  });

  it("B: grounding completes with little time remaining → RQS attaches, analyst skipped", async () => {
    await useRealScorer();
    registerPipeline({
      research: {
        name: "research",
        label: "Gathering evidence",
        execute: async () => ({ output: groundedResearchOutput(), costCents: 0 }),
      },
      analyst: {
        name: "analyst",
        label: "Preparing your answer",
        execute: async () => {
          throw new Error("analyst should have been skipped");
        },
      },
      critic: {
        name: "critic",
        label: "Checking sources",
        execute: async () => {
          throw new Error("critic should have been skipped");
        },
      },
    });

    agentRunFindFirst.mockResolvedValue(baseRun({ maxWallClockSeconds: 1 }));
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_deadline" });
    expect(result.status).toBe("COMPLETED");
    const fo = result.finalOutput as Record<string, unknown>;
    expect(fo.researchQuality).toBeTruthy();
    expect(fo.analystEnrichmentSkipped).toBe(true);
    expect(agentStepCreate.mock.calls.some((c) => c[0].data.status === "SKIPPED")).toBe(true);
  });

  it("C: analyst exceeds its budget → optional path aborted, RQS remains", async () => {
    await useRealScorer();
    registerPipeline({
      research: {
        name: "research",
        label: "Gathering evidence",
        execute: async () => ({ output: groundedResearchOutput(), costCents: 0 }),
      },
      analyst: {
        name: "analyst",
        label: "Preparing your answer",
        execute: async () => {
          throw new Error("analyst must not consume mandatory RQS budget");
        },
      },
      critic: {
        name: "critic",
        label: "Checking sources",
        execute: async () => {
          throw new Error("critic must not run");
        },
      },
    });

    // Remaining after research (~1s) << ANALYST_SAFE_BUDGET → skip optional work.
    agentRunFindFirst.mockResolvedValue(baseRun({ maxWallClockSeconds: 1 }));
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_deadline" });
    const fo = result.finalOutput as Record<string, unknown>;
    expect(fo.researchQuality).toBeTruthy();
    expect(fo.analystEnrichmentSkipped).toBe(true);
    expect(result.status).toBe("COMPLETED");
  });

  it("D: timeout after RQS attach → PARTIAL retains researchQuality", async () => {
    await useRealScorer();
    registerPipeline({
      research: {
        name: "research",
        label: "Gathering evidence",
        // Starts under wall clock, finishes after RQS attach, then next-iteration check trips.
        delayMs: 1100,
        execute: async () => ({ output: groundedResearchOutput(), costCents: 0 }),
      },
      analyst: {
        name: "analyst",
        label: "Preparing your answer",
        execute: async () => {
          throw new Error("analyst must not run after wall clock");
        },
      },
      critic: {
        name: "critic",
        label: "Checking sources",
        execute: async () => {
          throw new Error("critic must not run after wall clock");
        },
      },
    });

    agentRunFindFirst.mockResolvedValue(baseRun({ maxWallClockSeconds: 1 }));
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_deadline" });
    expect(result.status).toBe("PARTIAL");
    expect(result.userFacingError).toMatch(/taking too long/i);
    const fo = result.finalOutput as Record<string, unknown>;
    expect(fo.researchQuality).toBeTruthy();
    expect(fo.phase).toBe("PARTIAL_WITH_GROUNDED_QUALITY");
  }, 15_000);

  it("E: timeout/fail before grounding completes → no fake RQS", async () => {
    await useRealScorer();
    registerPipeline({
      research: {
        name: "research",
        label: "Gathering evidence",
        execute: async () => {
          throw new Error("research aborted before grounding");
        },
      },
      analyst: {
        name: "analyst",
        label: "Preparing your answer",
        execute: async () => ({ output: {}, costCents: 0 }),
      },
      critic: {
        name: "critic",
        label: "Checking sources",
        execute: async () => ({ output: {}, costCents: 0 }),
      },
    });

    agentRunFindFirst.mockResolvedValue(baseRun({ maxWallClockSeconds: 600 }));
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_deadline" });
    const fo = result.finalOutput as Record<string, unknown> | null;
    expect(fo?.researchQuality == null).toBe(true);
    expect(result.status === "FAILED" || result.status === "PARTIAL").toBe(true);
  });

  it("F: RQS computation failure → QUALITY_SCORING_FAILED, not generic timeout", async () => {
    scoreResearchQualityMock.mockImplementation(() => {
      throw new Error("scorer exploded");
    });

    registerPipeline({
      research: {
        name: "research",
        label: "Gathering evidence",
        execute: async () => ({ output: groundedResearchOutput(), costCents: 0 }),
      },
      analyst: {
        name: "analyst",
        label: "Preparing your answer",
        execute: async () => ({
          output: {
            ...groundedResearchOutput(),
            claims: groundedResearchOutput().findings,
          },
          costCents: 0,
        }),
      },
      critic: {
        name: "critic",
        label: "Checking sources",
        execute: async () => ({ output: { summary: "ok" }, costCents: 0 }),
      },
    });

    agentRunFindFirst.mockResolvedValue(baseRun({ maxWallClockSeconds: 600 }));
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_deadline" });
    const fo = result.finalOutput as Record<string, unknown>;
    expect(fo.phase).toBe("QUALITY_SCORING_FAILED");
    expect(fo.researchQuality).toBeUndefined();
    expect(String(result.userFacingError || "")).not.toMatch(/taking too long/i);
  });
});

describe("negative control preserved", () => {
  it("unsupported definitive claim still hard-fails", async () => {
    const actual = await vi.importActual<typeof import("@/services/research-quality")>(
      "@/services/research-quality",
    );
    const report = actual.scoreResearchQuality({
      originalUserPrompt: "What are UK GDPR CRM storage rules?",
      researchTopic: "UK GDPR CRM",
      answerMode: "DEEP",
      businessSpecific: false,
      organisationId: "org_test",
      outputOrganisationId: "org_test",
      claims: [
        {
          claim: "Absolutely every CRM is illegally storing contacts forever with no basis.",
          claimKind: "OFFICIAL",
        },
      ],
      sources: [],
      finalAnswerText:
        "Absolutely every CRM is illegally storing contacts forever with no basis.",
      gaps: [],
      contradictions: [],
    });
    expect(report.accepted).toBe(false);
    expect(
      report.hardGateFailures.some((f) => f.code === "UNSUPPORTED_DEFINITIVE_CLAIM"),
    ).toBe(true);
  });
});
