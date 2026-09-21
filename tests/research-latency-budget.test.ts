/**
 * Product latency budget (2026-09-14):
 * - Quick Ask research: a few seconds (hard cap RESEARCH_QUICK_CEILING_MS ≤ 12s).
 * - Even hard/Deep queries: finish or source-backed PARTIAL within RESEARCH_HARD_CEILING_MS ≤ 30s.
 * FAST skips extract when remaining wall-clock is below RESEARCH_FAST_EXTRACT_MIN_MS.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    researchJob: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    researchFinding: { create: vi.fn() },
    socialPost: { create: vi.fn() },
    trendSignal: { create: vi.fn() },
  },
}));

vi.mock("@/services/ai-spend-gate", () => ({
  assertWithinSpendCap: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/entitlements", () => ({
  assertEntitlement: vi.fn().mockResolvedValue(undefined),
  recordMeteredUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/research-tool-calls", () => ({
  recordResearchToolCall: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/research-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/research-evidence")>();
  return {
    ...actual,
    persistResearchSourceWithSnapshot: vi.fn().mockImplementation(async (input: { url: string }) => ({
      sourceId: `src-${input.url.length}`,
      freshnessScore: 0.5,
    })),
  };
});

vi.mock("@/services/social-intelligence", () => ({
  ingestResearchJobSocialContent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/digital-twin", () => ({
  getBusinessProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ RESEARCH_ADAPTER_CONCURRENCY: "2" }),
}));

vi.mock("@/lib/ai-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-models")>();
  return {
    ...actual,
    resolveModelForTier: () => "claude-sonnet-4-6",
  };
});

const completeStructuredSafe = vi.fn();
const completeStructured = vi.fn();
vi.mock("@/adapters/ai/structured", () => ({
  completeStructured: (...args: unknown[]) => completeStructured(...args),
  completeStructuredSafe: (...args: unknown[]) => completeStructuredSafe(...args),
  tryParseJson: (text: string) => JSON.parse(text),
}));

const searchConfiguredSources = vi.fn();
const listConfiguredSourcePlatforms = vi.fn(() => ["web"]);
vi.mock("@/adapters/sources", async () => {
  const actual = await vi.importActual<typeof import("@/adapters/sources")>("@/adapters/sources");
  return {
    ...actual,
    searchConfiguredSources: (...args: unknown[]) => searchConfiguredSources(...args),
    listConfiguredSourcePlatforms: () => listConfiguredSourcePlatforms(),
  };
});

import { prisma } from "@/lib/db";
import { researchAgent } from "@/agents/research";
import {
  ANALYST_SAFE_BUDGET_MS,
  CRITIC_SAFE_BUDGET_MS,
  RESEARCH_EXTRACT_MIN_MS,
  RESEARCH_HARD_CEILING_MS,
  RESEARCH_QUERY_CAP,
  RESEARCH_QUICK_CEILING_MS,
  RESEARCH_SOURCE_CAP,
  RESEARCH_SOURCE_FETCH_MS,
  raceWithTimeout,
  researchWallClockCapSeconds,
  shouldSkipOptionalEnrichment,
} from "@/agents/supervisor/research-deadline";

const SAMPLE_SOURCE = {
  url: "https://hire.example/rates",
  title: "UK plant hire day rates",
  platform: "web" as const,
  content: "A 3-tonne excavator typically hires from £120 per day in the UK.",
  author: null,
  publishedAt: null,
  engagement: null,
  rawMetadata: {},
};

describe("research latency budgets", () => {
  it("keeps documented Ask ceilings — fail this test if they regress upward", () => {
    expect(RESEARCH_QUICK_CEILING_MS).toBeLessThanOrEqual(12_000);
    expect(RESEARCH_HARD_CEILING_MS).toBeLessThanOrEqual(30_000);
    expect(ANALYST_SAFE_BUDGET_MS).toBeLessThanOrEqual(12_000);
    expect(CRITIC_SAFE_BUDGET_MS).toBeLessThanOrEqual(10_000);
    expect(RESEARCH_EXTRACT_MIN_MS).toBeLessThanOrEqual(6_000);
    expect(RESEARCH_SOURCE_FETCH_MS.FAST).toBeLessThanOrEqual(7_000);
    expect(RESEARCH_SOURCE_FETCH_MS.DEEP).toBeLessThanOrEqual(8_000);
    expect(RESEARCH_QUERY_CAP.FAST).toBeLessThanOrEqual(2);
    expect(RESEARCH_SOURCE_CAP.FAST).toBeLessThanOrEqual(5);
    expect(researchWallClockCapSeconds("QUICK")).toBeLessThanOrEqual(16);
    expect(researchWallClockCapSeconds("DEEP")).toBeLessThanOrEqual(30);
    expect(researchWallClockCapSeconds("EXECUTIVE")).toBeLessThanOrEqual(30);
  });

  it("skips analyst/critic when remaining wall-clock cannot cover them", () => {
    expect(
      shouldSkipOptionalEnrichment({
        agentName: "analyst",
        remainingMs: ANALYST_SAFE_BUDGET_MS,
      }),
    ).toBe(true);
    expect(
      shouldSkipOptionalEnrichment({
        agentName: "analyst",
        remainingMs: ANALYST_SAFE_BUDGET_MS + 3_000,
      }),
    ).toBe(false);
    expect(
      shouldSkipOptionalEnrichment({
        agentName: "critic",
        remainingMs: CRITIC_SAFE_BUDGET_MS,
      }),
    ).toBe(true);
    expect(
      shouldSkipOptionalEnrichment({
        agentName: "research",
        remainingMs: 0,
      }),
    ).toBe(false);
  });

  it("raceWithTimeout returns the fallback instead of hanging", async () => {
    const started = Date.now();
    const value = await raceWithTimeout(
      new Promise<string>(() => undefined),
      40,
      () => "partial",
    );
    expect(value).toBe("partial");
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("Quick vs Deep research LLM budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listConfiguredSourcePlatforms.mockReturnValue(["web"]);
    searchConfiguredSources.mockResolvedValue({
      results: [SAMPLE_SOURCE],
      errors: [],
      billableCents: 1,
    });
    completeStructuredSafe.mockResolvedValue({
      ok: true,
      data: { findings: [] },
    });
    (prisma.researchJob.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "job-lat",
    });
    (prisma.researchJob.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.researchJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-lat" });
    (prisma.researchJob.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-lat" });
    (prisma.researchFinding.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("FAST path skips extract LLM when wall-clock is tight and finishes in well under 2s", async () => {
    const started = Date.now();
    const result = await researchAgent.execute(
      { topic: "UK plant hire pricing", depth: "FAST", maxSources: 5 },
      {
        organisationId: "org-lat",
        agentRunId: "run-fast",
        agentStepId: "step-1",
        deadlineAt: Date.now() + 2_000,
      },
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(completeStructured).not.toHaveBeenCalled();
    expect(completeStructuredSafe).not.toHaveBeenCalled();
    expect(result.output.sourceCount).toBe(1);
    expect(result.output.findings.length).toBeGreaterThan(0);
    expect(result.output.findings[0]?.sourceUrl).toBe(SAMPLE_SOURCE.url);
    expect(result.output.summary).toMatch(/DIRECT ANSWER/);
  });

  it("STANDARD still attempts extract when the deadline has room", async () => {
    await researchAgent.execute(
      { topic: "UK plant hire pricing", depth: "STANDARD" },
      {
        organisationId: "org-lat",
        agentRunId: "run-std",
        agentStepId: "step-1",
        deadlineAt: Date.now() + 25_000,
      },
    );
    expect(completeStructured).not.toHaveBeenCalled();
    expect(completeStructuredSafe).toHaveBeenCalledTimes(1);
  });

  it("skips extract when remaining wall-clock is below RESEARCH_EXTRACT_MIN_MS", async () => {
    const result = await researchAgent.execute(
      { topic: "UK plant hire pricing", depth: "STANDARD" },
      {
        organisationId: "org-lat",
        agentRunId: "run-tight",
        agentStepId: "step-1",
        // Enough time to search, not enough for the extract LLM.
        deadlineAt: Date.now() + 3_500,
      },
    );
    expect(searchConfiguredSources).toHaveBeenCalled();
    expect(completeStructuredSafe).not.toHaveBeenCalled();
    expect(result.output.sourceCount).toBe(1);
    expect(result.output.findings.length).toBeGreaterThan(0);
  });
});
