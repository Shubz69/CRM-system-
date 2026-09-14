import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  inferResearchListenPlatforms,
  labelResearchListenChannel,
} from "@/lib/research-listen-platforms";

describe("inferResearchListenPlatforms", () => {
  const configured = ["web", "instagram", "linkedin", "tiktok", "twitter", "threads"] as const;

  it("keeps generic desk research on web only", () => {
    expect(inferResearchListenPlatforms("UK plant hire pricing", [...configured])).toEqual(["web"]);
    expect(
      inferResearchListenPlatforms("UK GDPR CRM contact storage", [...configured]),
    ).toEqual(["web"]);
  });

  it("adds Apify Instagram when the ask names Instagram", () => {
    expect(
      inferResearchListenPlatforms("Instagram growth content strategy", [...configured]),
    ).toEqual(["web", "instagram"]);
  });

  it("adds LinkedIn and TikTok when those networks are named", () => {
    expect(
      inferResearchListenPlatforms("LinkedIn and TikTok posting cadence", [...configured]),
    ).toEqual(["web", "linkedin", "tiktok"]);
  });

  it("does not invent an unconfigured social adapter", () => {
    expect(inferResearchListenPlatforms("Instagram growth", ["web"])).toEqual(["web"]);
  });
});

describe("labelResearchListenChannel", () => {
  it("labels Apify social listen separately from web search", () => {
    expect(labelResearchListenChannel("instagram")).toBe("Apify · Instagram");
    expect(labelResearchListenChannel("linkedin")).toBe("Apify · LinkedIn");
    expect(labelResearchListenChannel("tiktok")).toBe("Apify · TikTok");
    expect(labelResearchListenChannel("web")).toBe("Web search");
  });
});

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

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ RESEARCH_ADAPTER_CONCURRENCY: "2" }),
}));

const searchConfiguredSources = vi.fn();
const listConfiguredSourcePlatforms = vi.fn();
vi.mock("@/adapters/sources", async () => {
  const actual = await vi.importActual<typeof import("@/adapters/sources")>("@/adapters/sources");
  return {
    ...actual,
    searchConfiguredSources: (...args: unknown[]) => searchConfiguredSources(...args),
    listConfiguredSourcePlatforms: () => listConfiguredSourcePlatforms(),
  };
});

vi.mock("@/adapters/ai/structured", () => ({
  completeStructured: vi.fn(),
  completeStructuredSafe: vi.fn().mockResolvedValue({ ok: true, data: { findings: [] } }),
  tryParseJson: (text: string) => JSON.parse(text),
}));

describe("research agent Apify listen wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { prisma } = await import("@/lib/db");
    listConfiguredSourcePlatforms.mockReturnValue(["web", "instagram", "linkedin", "tiktok"]);
    searchConfiguredSources.mockResolvedValue({
      results: [
        {
          url: "https://www.instagram.com/p/abc/",
          title: "Growth reel",
          platform: "instagram",
          content: "A public Instagram post about weekly reel cadence.",
          author: "creator",
          publishedAt: null,
          engagement: null,
          rawMetadata: { retrievalMechanism: "apify" },
        },
      ],
      errors: [],
      billableCents: 2,
    });
    (prisma.researchJob.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-ig" });
    (prisma.researchJob.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.researchJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-ig" });
    (prisma.researchJob.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-ig" });
    (prisma.researchFinding.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("searches Apify Instagram when the topic names Instagram and labels the channel", async () => {
    const { researchAgent } = await import("@/agents/research");
    const result = await researchAgent.execute(
      { topic: "Instagram growth content strategy", depth: "FAST", maxSources: 5 },
      {
        organisationId: "org-ig",
        agentRunId: "run-ig",
        agentStepId: "step-1",
      },
    );

    const calledPlatforms = searchConfiguredSources.mock.calls.flatMap((call) => {
      const args = call[0] as { platforms?: string[] };
      return args.platforms ?? [];
    });
    expect(calledPlatforms).toContain("instagram");
    expect(calledPlatforms).toContain("web");
    expect(calledPlatforms).not.toContain("tiktok");
    expect(result.output.sources[0]?.platform).toBe("instagram");
    expect(result.output.sources[0]?.listenChannel).toBe("Apify · Instagram");
    expect(result.output.findings.length).toBeGreaterThan(0);
    expect(result.output.findings[0]?.sourceUrl).toBe("https://www.instagram.com/p/abc/");
  });
});
