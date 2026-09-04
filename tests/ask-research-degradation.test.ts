import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("@/lib/db", () => ({
  prisma: {
    researchJob: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
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

vi.mock("@/services/research-evidence", () => ({
  parseClaimKind: (v: string) => v || "UNKNOWN",
  persistResearchSourceWithSnapshot: vi.fn().mockImplementation(async (input: { url: string }) => ({
    sourceId: `src-${input.url.length}`,
    freshnessScore: 0.5,
  })),
}));

vi.mock("@/services/social-intelligence", () => ({
  ingestResearchJobSocialContent: vi.fn().mockResolvedValue(undefined),
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
import { analystAgent } from "@/agents/analyst";
import { summariseAgent } from "@/agents/summarise";
import {
  CUSTOMER_AI_UNAVAILABLE,
  CUSTOMER_AI_VALIDATE_FAILED,
  toCustomerAiError,
} from "@/lib/customer-ai-errors";
import { resolveOperationalAnthropicModel, isRetiredAnthropicModel } from "@/lib/ai-models";
import { ASK_OUTCOME_CARDS } from "@/lib/navigation";

describe("Ask/Research degradation + privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listConfiguredSourcePlatforms.mockReturnValue(["web"]);
    (prisma.researchJob.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "job-1",
    });
    (prisma.researchJob.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.researchFinding.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("research fails honestly when findings extract fails Zod after evidence", async () => {
    searchConfiguredSources.mockResolvedValue({
      results: [
        {
          url: "https://example.com/a",
          title: "A",
          platform: "web",
          content: "Evidence about UK SME AI consulting demand.",
          author: null,
          publishedAt: null,
          engagement: null,
          rawMetadata: {},
        },
      ],
      errors: [],
      billableCents: 3,
    });
    completeStructured.mockResolvedValueOnce({
      queries: ["UK SME AI consulting", "AI implementation UK"],
    });
    completeStructuredSafe.mockResolvedValueOnce({
      ok: false,
      reason: "AI output failed Zod validation after repair attempt",
      failureClass: "SCHEMA_FAILED",
      raw: { findings: [{ claim: "x", sourceUrl: "not-a-url" }] },
    });

    await expect(
      researchAgent.execute(
        { topic: "UK SME demand for AI consultancy" },
        {
          organisationId: "org-qa",
          agentRunId: "run-1",
          agentStepId: "step-1",
        },
      ),
    ).rejects.toThrow(/verify the answer structure/i);

    expect(prisma.researchJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          error: "structured_extraction_failed",
        }),
      }),
    );
  });

  it("analyst falls back to findings when brief schema fails", async () => {
    (prisma.researchJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "job-1",
      topic: "AI ops",
      sources: [
        {
          id: "s1",
          url: "https://example.com/a",
          title: "A",
          platform: "web",
          content: "Founders buying AI automation",
        },
      ],
      findings: [
        {
          id: "f1",
          claim: "UK founders buy AI ops support",
          researchSourceId: "s1",
          evidenceExcerpt: "Founders buying",
          confidence: 0.7,
        },
      ],
    });
    completeStructuredSafe.mockResolvedValueOnce({
      ok: false,
      reason: "schema fail",
      raw: {},
    });

    const result = await analystAgent.execute(
      { researchJobId: "job-1", topic: "AI ops" },
      { organisationId: "org-qa", agentRunId: "run-1", agentStepId: "step-2" },
    );

    expect(result.output.claims.length).toBeGreaterThan(0);
    expect(result.output.shortAnswer).toMatch(/UK founders/i);
    expect(result.output.gaps[0]).toMatch(/Structured analyst synthesis failed/i);
  });

  it("summarise degrades instead of throwing when structured completion fails", async () => {
    completeStructuredSafe.mockResolvedValueOnce({ ok: false, reason: "boom" });
    const result = await summariseAgent.execute(
      { text: "Agent Desk helps UK SMEs adopt AI with forward deployed engineering." },
      { organisationId: "org-qa", agentRunId: "run-1", agentStepId: "step-1" },
    );
    expect(result.output.summary).toMatch(/Agent Desk/);
  });

  it("scrubs provider/model leaks from customer AI errors", () => {
    expect(
      toCustomerAiError(
        'Anthropic request failed (404): {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-20250514"}}',
      ),
    ).toBe(CUSTOMER_AI_UNAVAILABLE);
    expect(toCustomerAiError("AI validation failed: Anthropic 404")).toBe(
      CUSTOMER_AI_VALIDATE_FAILED,
    );
    expect(isRetiredAnthropicModel("claude-sonnet-4-20250514")).toBe(true);
    expect(resolveOperationalAnthropicModel("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-6");
  });

  it("Ask outcome cards either navigate or prefill (never empty handlers)", () => {
    for (const card of ASK_OUTCOME_CARDS) {
      expect(Boolean(card.href || card.prefill)).toBe(true);
    }
    expect(ASK_OUTCOME_CARDS.some((c) => c.title === "Research a topic")).toBe(true);
  });

  it("flexible finding schema accepts scheme-less URLs", () => {
    const flexibleSourceUrl = z
      .string()
      .min(1)
      .transform((raw) => {
        const trimmed = raw.trim();
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(trimmed)) return `https://${trimmed}`;
        return trimmed;
      })
      .pipe(z.string().url());
    expect(flexibleSourceUrl.parse("example.com/path")).toBe("https://example.com/path");
  });
});

describe("Ask cost UI copy", () => {
  it("never claims no charge while a run is in progress with zero rolled-up cost", async () => {
    const { costNote } = await import("@/services/agent-runs");
    expect(costNote(0, "RUNNING")).toMatch(/updates after tool calls/i);
    expect(costNote(0, "RUNNING")).not.toMatch(/No AI charge/i);
    expect(costNote(0, "FAILED")).toMatch(/monthly AI spend/i);
    expect(costNote(12, "COMPLETED")).toMatch(/12¢/);
  });
});
