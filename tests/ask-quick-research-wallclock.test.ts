/**
 * Production regression: QUICK Ask research hit MAX_WALL_CLOCK with empty
 * steps/finalOutput after queue + format-clarification wait burned the 12s
 * ceiling before any search ran (AgentRun cmu127age0003l504xgb7bhno).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Agent } from "@/agents/types";
import { isQuickResearchAsk, looksLikeResearch } from "@/agents/supervisor/plan";
import {
  hydrateBlankResearchFinalOutput,
  honestEmptyResearchPartial,
  isBlankAskFinalOutput,
  researchPartialFromJobRow,
  salvageResearchPartialFromDb,
  salvageUserFacingError,
  shapeSalvagedAskOutput,
} from "@/agents/supervisor/research-salvage";
import { researchWallClockCapSeconds } from "@/agents/supervisor/research-deadline";
import {
  quotedFindingsFromResearchSources,
  softenPartialSourcesOnlyError,
} from "@/lib/research-job-present";

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
    expect(researchWallClockCapSeconds("QUICK")).toBeLessThanOrEqual(60);
    expect(researchWallClockCapSeconds("QUICK")).toBeGreaterThanOrEqual(50);
  });

  it("treats Instagram Reels growth Asks as Quick research (in-process 60s path)", () => {
    const q =
      "What Instagram Reels content and posting strategy should @shubzfx use to grow";
    expect(looksLikeResearch(q)).toBe(true);
    expect(isQuickResearchAsk("QUICK", q)).toBe(true);
    expect(looksLikeResearch("Summarise this: we book consults through Instagram DMs")).toBe(
      false,
    );
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
    const customer = shapeSalvagedAskOutput(
      salvaged,
      "What Instagram Reels content and posting strategy should @shubzfx use to grow",
    ) as { typedAnswers?: { strategy?: { title?: string }; scripts?: { title?: string } } };
    expect(customer.typedAnswers?.strategy?.title).toBe("Strategy");
    expect(customer.typedAnswers?.scripts?.title).toBe("Scripts");
    expect(salvageUserFacingError(customer, true, salvaged!.sourceCount)).toBeNull();
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
      await vi.advanceTimersByTimeAsync(55_000);
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
        typedAnswers?: { strategy?: { title?: string; body?: string } };
      };
      expect(fo).toBeTruthy();
      expect(fo.sources?.some((s) => s.url === HIRE) || fo.findings?.some((f) => f.sourceUrl === HIRE)).toBe(
        true,
      );
      expect(fo.typedAnswers?.strategy?.title).toBe("Strategy");
      expect(JSON.stringify(fo)).not.toBe("null");
      expect(JSON.stringify(fo)).toMatch(/hire\.example|£120|plant hire/i);
      expect(result.userFacingError || "").not.toMatch(/finished 0 of|sources gathered|taking too long/i);
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it("on wall-clock with a hanging search and no salvage, still returns a non-null honest PARTIAL", async () => {
    vi.useFakeTimers();
    try {
      registerAgent(makeResearchAgent(async () => new Promise(() => undefined) as never));
      researchJobFindFirst.mockResolvedValue(null);
      agentRunFindFirst.mockResolvedValue(
        baseRun({
          startedAt: new Date(Date.now() - 68_000),
          maxWallClockSeconds: 30,
        }),
      );

      const pending = executeAgentRun({ organisationId: "org_a", runId: "run_quick_hire" });
      await vi.advanceTimersByTimeAsync(55_000);
      const result = await pending;

      expect(result.status).toBe("PARTIAL");
      expect(result.finalOutput).not.toBeNull();
      expect(result.finalOutput).not.toBeUndefined();
      expect(JSON.stringify(result.finalOutput)).not.toBe("null");
      const fo = result.finalOutput as { answer?: string; summary?: string; findings?: unknown[]; sources?: unknown[] };
      expect((fo.answer || fo.summary || "").length).toBeGreaterThan(20);
      expect(result.userFacingError || "").not.toMatch(/finished 0 of/i);
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it("general path MAX_WALL_CLOCK (stored 30s cap, 68s-old startedAt) never returns blank finalOutput", async () => {
    vi.useFakeTimers();
    try {
      registerAgent(makeResearchAgent(async () => new Promise(() => undefined) as never));
      researchJobFindFirst.mockResolvedValue(null);
      let finds = 0;
      agentRunFindFirst.mockImplementation(async () => {
        finds += 1;
        if (finds === 2) return null;
        return baseRun({
          startedAt: new Date(Date.now() - 68_000),
          maxWallClockSeconds: 30,
        });
      });

      const pending = executeAgentRun({ organisationId: "org_a", runId: "run_quick_hire" });
      await vi.advanceTimersByTimeAsync(62_000);
      const result = await pending;

      expect(result.status).toBe("PARTIAL");
      expect(result.finalOutput).not.toBeNull();
      expect(JSON.stringify(result.finalOutput)).not.toBe("null");
      const fo = result.finalOutput as { answer?: string; summary?: string };
      expect((fo.answer || fo.summary || "").length).toBeGreaterThan(20);
      expect(result.userFacingError || "").not.toMatch(/finished 0 of/i);
      expect(
        agentRunUpdate.mock.calls.some((c) => {
          const data = (c[0] as { data?: { error?: string; finalOutput?: unknown } }).data;
          return data?.error === "MAX_WALL_CLOCK" && data.finalOutput != null;
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);
});

describe("progress hydration + partial_sources_only honesty", () => {
  beforeEach(() => {
    researchJobFindFirst.mockReset();
    researchJobFindFirst.mockResolvedValue(null);
  });

  it("hydrates a blank PARTIAL AgentRun from an org-scoped ResearchJob", async () => {
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
    const hydrated = await hydrateBlankResearchFinalOutput({
      organisationId: "org_a",
      agentRunId: "run_quick_hire",
      request: "Research plant hire UK pricing",
      status: "PARTIAL",
      finalOutput: null,
    });
    expect(hydrated.salvaged).toBe(true);
    expect(hydrated.sourceCount).toBeGreaterThan(0);
    expect(JSON.stringify(hydrated.finalOutput)).toMatch(/hire\.example|£120/i);
    expect(isBlankAskFinalOutput(hydrated.finalOutput)).toBe(false);
    const shaped = hydrated.finalOutput as {
      typedAnswers?: { strategy?: { title?: string; body?: string } };
    };
    expect(shaped.typedAnswers?.strategy?.title).toBe("Strategy");
    expect(shaped.typedAnswers?.strategy?.body?.length).toBeGreaterThan(8);
    expect(salvageUserFacingError(hydrated.finalOutput, true, hydrated.sourceCount)).toBeNull();
    expect(JSON.stringify(hydrated.finalOutput)).not.toMatch(/sources gathered/i);
  });

  it("blank wall-clock with no job still yields a non-null honest brief", () => {
    const empty = honestEmptyResearchPartial("Research plant hire UK pricing");
    expect(isBlankAskFinalOutput(null)).toBe(true);
    expect(isBlankAskFinalOutput(empty)).toBe(false);
    expect(empty.summary.length).toBeGreaterThan(20);
    expect(empty.sources).toEqual([]);
  });

  it("quotes sources as findings when findings=0 (never invents stats)", () => {
    const findings = quotedFindingsFromResearchSources([
      {
        id: "src_1",
        url: HIRE,
        title: "UK plant hire day rates",
        snippet: "A 3-tonne excavator typically hires from £120 per day in the UK.",
        platform: "web",
      },
    ]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.sourceUrl).toBe(HIRE);
    expect(findings[0]?.claim).toMatch(/£120|plant hire/i);
    const softened = softenPartialSourcesOnlyError({
      error: "partial_sources_only",
      userFacingError: "Structured findings were incomplete",
      sourceCount: 1,
    });
    expect(softened.error).toBeNull();
    expect(softened.userFacingError).toBeNull();
  });
});

describe("multi-tenant salvage scope", () => {
  it("scopes ResearchJob lookup by organisationId.equals (no cross-org leakage)", async () => {
    researchJobFindFirst.mockResolvedValue(null);
    await salvageResearchPartialFromDb({
      organisationId: "org_a",
      agentRunId: "run_quick_hire",
    });
    expect(researchJobFindFirst).toHaveBeenCalled();
    const arg = researchJobFindFirst.mock.calls[0]?.[0] as {
      where: {
        organisationId: { equals: string };
        agentRunId: { equals: string };
      };
      include: {
        sources: { where: { organisationId: { equals: string } } };
        findings: { where: { organisationId: { equals: string } } };
      };
    };
    expect(arg.where.organisationId.equals).toBe("org_a");
    expect(arg.where.agentRunId.equals).toBe("run_quick_hire");
    expect(arg.include.sources.where.organisationId.equals).toBe("org_a");
    expect(arg.include.findings.where.organisationId.equals).toBe("org_a");

    await salvageResearchPartialFromDb({
      organisationId: "org_b",
      agentRunId: "run_quick_hire",
    });
    const other = researchJobFindFirst.mock.calls[1]?.[0] as {
      where: { organisationId: { equals: string } };
    };
    expect(other.where.organisationId.equals).toBe("org_b");
    expect(other.where.organisationId.equals).not.toBe("org_a");
  });
});
