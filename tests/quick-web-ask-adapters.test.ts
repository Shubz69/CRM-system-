/**
 * Production regression: in-process Quick Ask finished with empty adapters
 * ("No sources were returned… Web research results were unavailable")
 * instead of source-backed findings or an honest AUTH_REQUIRED missing-key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const envState = {
  RESEARCH_ADAPTER_CONCURRENCY: "2",
  TAVILY_API_KEY: undefined as string | undefined,
  EXA_API_KEY: undefined as string | undefined,
};

vi.mock("@/lib/env", () => ({
  getEnv: () => envState,
}));

vi.mock("@/lib/ai-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-models")>();
  return {
    ...actual,
    resolveModelForTier: () => "claude-sonnet-4-6",
  };
});

vi.mock("@/adapters/ai/structured", () => ({
  completeStructured: vi.fn(),
  completeStructuredSafe: vi.fn().mockResolvedValue({ ok: true, data: { findings: [] } }),
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
import { WEB_SEARCH_MISSING_KEY_MESSAGE } from "@/adapters/sources/web";

const HIRE = "https://hire.example/rates";
const SNIPPET = "A 3-tonne excavator typically hires from £120 per day in the UK.";

const SAMPLE_SOURCE = {
  url: HIRE,
  title: "UK plant hire day rates",
  platform: "web" as const,
  content: SNIPPET,
  author: null,
  publishedAt: null,
  engagement: null,
  rawMetadata: { provider: "tavily" },
};

describe("Quick web Ask — adapter honesty + plant-hire happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.TAVILY_API_KEY = undefined;
    envState.EXA_API_KEY = undefined;
    listConfiguredSourcePlatforms.mockReturnValue(["web"]);
    (prisma.researchJob.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-hire" });
    (prisma.researchJob.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.researchJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-hire" });
    (prisma.researchJob.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-hire" });
    (prisma.researchFinding.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("does not invent sources when adapters return empty + unavailable", async () => {
    envState.TAVILY_API_KEY = "tvly-test";
    searchConfiguredSources.mockResolvedValue({
      results: [],
      errors: [
        {
          platform: "web",
          message: "Web research results were unavailable for this search.",
          code: "SOURCE_UNAVAILABLE",
        },
      ],
      billableCents: 0,
    });

    const result = await researchAgent.execute(
      { topic: "Research plant hire UK pricing", depth: "FAST", maxSources: 5 },
      { organisationId: "org-hire", agentRunId: "run-empty", agentStepId: "step-1" },
    );

    expect(result.output.sourceCount).toBe(0);
    expect(result.output.sources).toEqual([]);
    expect(result.output.findings).toEqual([]);
    expect(result.output.summary).toMatch(/No sources were returned|unavailable/i);
    expect(JSON.stringify(result.output.sources)).toBe("[]");
    expect(JSON.stringify(result.output.findings)).toBe("[]");
    expect(result.output.summary).not.toMatch(/AUTH_REQUIRED/);
  });

  it("surfaces AUTH_REQUIRED + Vercel key names when TAVILY/EXA are missing", async () => {
    listConfiguredSourcePlatforms.mockReturnValue([]);
    searchConfiguredSources.mockResolvedValue({
      results: [],
      errors: [
        {
          platform: "web",
          message: WEB_SEARCH_MISSING_KEY_MESSAGE,
          code: "AUTH_REQUIRED",
        },
      ],
      billableCents: 0,
    });

    const result = await researchAgent.execute(
      { topic: "Research plant hire UK pricing", depth: "FAST", maxSources: 5 },
      { organisationId: "org-hire", agentRunId: "run-auth", agentStepId: "step-1" },
    );

    expect(result.output.sourceCount).toBe(0);
    expect(result.output.sources).toEqual([]);
    expect(result.output.findings).toEqual([]);
    expect(result.output.summary).toMatch(/AUTH_REQUIRED/);
    expect(result.output.summary).toMatch(/TAVILY_API_KEY/);
    expect(result.output.summary).toMatch(/EXA_API_KEY/);
    expect(result.output.summary).toMatch(/Vercel/i);
    expect(result.output.summary).not.toMatch(/Quality gate failed/i);
  });

  it("returns ≥1 plant-hire source URL + snippet on the mocked success path", async () => {
    envState.TAVILY_API_KEY = "tvly-test";
    searchConfiguredSources.mockResolvedValue({
      results: [SAMPLE_SOURCE],
      errors: [],
      billableCents: 1,
    });

    const result = await researchAgent.execute(
      { topic: "Research plant hire UK pricing", depth: "FAST", maxSources: 5 },
      { organisationId: "org-hire", agentRunId: "run-ok", agentStepId: "step-1" },
    );

    expect(searchConfiguredSources).toHaveBeenCalled();
    const searchArg = searchConfiguredSources.mock.calls[0]?.[0] as {
      platforms?: string[];
      options?: { qualityBudget?: string; timeoutMs?: number };
    };
    expect(searchArg.platforms).toEqual(["web"]);
    expect(searchArg.options?.qualityBudget).toBe("FAST");
    expect(searchArg.options?.timeoutMs).toBeGreaterThanOrEqual(5_000);

    expect(result.output.sourceCount).toBeGreaterThanOrEqual(1);
    expect(result.output.sources.some((s) => s.url === HIRE)).toBe(true);
    expect(result.output.sources[0]?.snippet).toMatch(/£120|excavator|plant hire/i);
    expect(result.output.findings.length).toBeGreaterThan(0);
    expect(result.output.findings[0]?.sourceUrl).toBe(HIRE);
    expect(JSON.stringify(result.output.findings[0])).toMatch(/£120|excavator|plant hire/i);
  });
});
