/**
 * Production regression: QUICK Ask research hit MAX_WALL_CLOCK with empty
 * steps/finalOutput after queue + format-clarification wait burned the 12s
 * ceiling before any search ran (AgentRun cmu127age0003l504xgb7bhno).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Agent } from "@/agents/types";
import { isQuickResearchAsk, looksLikeResearch } from "@/agents/supervisor/plan";
import { researchPartialFromJobRow } from "@/agents/supervisor/research-salvage";
import { researchWallClockCapSeconds } from "@/agents/supervisor/research-deadline";

const HIRE = "https://hire.example/rates";

const agentRunFindFirst = vi.fn();
const agentRunUpdate = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
  id: args.where.id,
  ...args.data,
}));
const agentRunUpdateMany = vi.fn(async () => ({ count: 1 }));
const agentStepCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: `step_${String(args.data.position ?? 0)}`,
  ...args.data,
}));
const agentStepFindFirst = vi.fn(async (args: { where: { id?: { equals?: string } } }) => ({
  id: args.where.id?.equals || "step_0",
}));
const agentStepUpdate = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
  id: args.where.id,
  ...args.data,
}));
const agentStepCount = vi.fn(async () => 0);
const researchJobFindFirst = vi.fn(async () => null);

vi.mock("@/lib/db", () => ({
  prisma: {
    agentRun: {
      findFirst: (...a: unknown[]) => agentRunFindFirst(...a),
      updateMany: (...a: unknown[]) => agentRunUpdateMany(...a),
      update: (...a: unknown[]) => agentRunUpdate(...a),
    },
    agentStep: {
      create: (...a: unknown[]) => agentStepCreate(...a),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: (...a: unknown[]) => agentStepFindFirst(...a),
      update: (...a: unknown[]) => agentStepUpdate(...a),
      count: (...a: unknown[]) => agentStepCount(...a),
    },
    organisation: {
      findFirst: vi.fn(async () => ({ id: "org_a", name: "Shobhit Agency" })),
    },
    organisationAgentLimits: {
      findUnique: vi.fn(async () => null),
    },
    researchJob: {
      findFirst: (...a: unknown[]) => researchJobFindFirst(...a),
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

import { executeAgentRun } from "@/agents/supervisor/execute";
import { registerAgent, resetAgentBootstrap } from "@/agents";

const passthrough = z.record(z.string(), z.unknown());

const plantHireOutput = {
  researchJobId: "job_hire",
  topic: "plant hire UK pricing",
  summary: "UK plant-hire pages quote excavator day rates around published hire-house lists.",
  findings: [
    {
      claim: "UK plant-hire pages quote a 3-tonne excavator from £120 per day.",
      sourceUrl: HIRE,
      evidenceExcerpt: "A 3-tonne excavator typically hires from £120 per day in the UK.",
      sourceTitle: "UK plant hire day rates",
    },
  ],
  sources: [
    {
      url: HIRE,
      title: "UK plant hire day rates",
      snippet: "A 3-tonne excavator typically hires from £120 per day in the UK.",
      platform: "web",
    },
  ],
  sourceCount: 1,
  phase: "PARTIAL_WITH_SOURCES",
};

function makeResearchAgent(execute: Agent["execute"]): Agent {
  return {
    name: "research",
    description: "research",
    inputSchema: passthrough,
    outputSchema: passthrough,
    tier: "cheap",
    estimateCostCents: () => 1,
    userFacingLabel: () => "Researching plant hire UK pricing across available sources",
    execute,
  };
}

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_quick_hire",
    organisationId: "org_a",
    userId: "user_1",
    triggeredBy: "user",
    request: "Research plant hire UK pricing",
    plan: null,
    plainEnglishPlan: "I'll do a fast sourced scan…",
    clarificationQuestion: null,
    clarificationOptions: null,
    status: "PENDING",
    startedAt: new Date(),
    finishedAt: null,
    totalCostCents: 0,
    error: null,
    userFacingError: null,
    partialResults: { latencyTrace: { enqueuedAt: Date.now() - 60_000, syncFastPath: 0 } },
    finalOutput: null,
    answerMode: "QUICK",
    maxSteps: 8,
    maxWallClockSeconds: 12,
    maxSpendCents: null,
    bullJobId: null,
    referenceAssetId: null,
    pendingBrief: { originalUserPrompt: "Research plant hire UK pricing" },
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("Quick research dispatch helpers", () => {
  it("treats plant-hire Ask as Quick research (sync FAST path, not CRM)", () => {
    expect(looksLikeResearch("Research plant hire UK pricing")).toBe(true);
    expect(isQuickResearchAsk("QUICK", "Research plant hire UK pricing")).toBe(true);
    expect(isQuickResearchAsk("DEEP", "Research plant hire UK pricing")).toBe(false);
    expect(researchWallClockCapSeconds("QUICK")).toBeLessThanOrEqual(12);
  });
});

describe("source-backed PARTIAL salvage", () => {
  it("turns gathered sources into findings with URL + snippet (never invents stats)", () => {
    const salvaged = researchPartialFromJobRow({
      id: "job_hire",
      topic: "plant hire UK pricing",
      sources: [
        {
          url: HIRE,
          title: "UK plant hire day rates",
          content: "A 3-tonne excavator typically hires from £120 per day in the UK.",
          platform: "web",
          author: null,
        },
      ],
      findings: [],
    });
    expect(salvaged).toBeTruthy();
    expect(salvaged!.sources[0]?.url).toBe(HIRE);
    expect(salvaged!.findings.length).toBeGreaterThan(0);
    expect(salvaged!.findings[0]?.sourceUrl).toBe(HIRE);
    expect(salvaged!.findings[0]?.claim).toMatch(/£120|plant hire/i);
    expect(salvaged!.phase).toBe("PARTIAL_WITH_SOURCES");
  });

  it("returns null when nothing was gathered (does not invent sources)", () => {
    expect(
      researchPartialFromJobRow({
        id: "job_empty",
        topic: "plant hire UK pricing",
        sources: [],
        findings: [],
      }),
    ).toBeNull();
  });
});

describe("QUICK execute — empty-steps wall-clock regression", () => {
  beforeEach(() => {
    resetAgentBootstrap();
    agentRunFindFirst.mockReset();
    agentRunUpdate.mockClear();
    agentStepCreate.mockClear();
    agentStepCount.mockReset();
    agentStepCount.mockResolvedValue(0);
    researchJobFindFirst.mockReset();
    researchJobFindFirst.mockResolvedValue(null);
  });

  it("still runs FAST research when enqueue/clarify wait already exceeded the 12s cap", async () => {
    const execute = vi.fn(async () => ({ output: plantHireOutput, costCents: 1 }));
    registerAgent(makeResearchAgent(execute));
    agentRunFindFirst.mockResolvedValue(
      baseRun({
        startedAt: new Date(Date.now() - 68_000),
        maxWallClockSeconds: 12,
      }),
    );

    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_quick_hire" });

    expect(execute).toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
    expect(
      agentRunUpdate.mock.calls.some(
        (c) => (c[0] as { data?: { error?: string } }).data?.error === "MAX_WALL_CLOCK",
      ),
    ).toBe(false);
    const fo = result.finalOutput as {
      findings?: Array<{ sourceUrl?: string }>;
      sources?: Array<{ url?: string }>;
      answer?: string;
    };
    expect(fo.sources?.some((s) => s.url === HIRE) || fo.findings?.some((f) => f.sourceUrl === HIRE)).toBe(
      true,
    );
    expect(JSON.stringify(fo)).toMatch(/£120|plant hire|hire\.example/i);
  });

  it("on wall-clock with a hanging search, surfaces salvaged sources instead of blank finalOutput", async () => {
    vi.useFakeTimers();
    try {
      registerAgent(
        makeResearchAgent(async () => new Promise(() => undefined) as never),
      );
      researchJobFindFirst.mockResolvedValue({
        id: "job_hire",
        topic: "plant hire UK pricing",
        brief: null,
        sources: [
          {
            url: HIRE,
            title: "UK plant hire day rates",
            content: "A 3-tonne excavator typically hires from £120 per day in the UK.",
            platform: "web",
            author: null,
          },
        ],
        findings: [],
      });
      agentRunFindFirst.mockResolvedValue(baseRun({ startedAt: new Date(Date.now() - 68_000) }));

      const pending = executeAgentRun({ organisationId: "org_a", runId: "run_quick_hire" });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.status).toBe("PARTIAL");
      expect(
        agentRunUpdate.mock.calls.some(
          (c) => (c[0] as { data?: { error?: string } }).data?.error === "MAX_WALL_CLOCK",
        ),
      ).toBe(true);
      const fo = result.finalOutput as {
        findings?: Array<{ sourceUrl?: string; claim?: string }>;
        sources?: Array<{ url?: string }>;
      };
      expect(fo).toBeTruthy();
      expect(fo.sources?.some((s) => s.url === HIRE) || fo.findings?.some((f) => f.sourceUrl === HIRE)).toBe(
        true,
      );
      expect(JSON.stringify(fo)).not.toBe("null");
      expect(JSON.stringify(fo)).toMatch(/hire\.example|£120|plant hire/i);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});
