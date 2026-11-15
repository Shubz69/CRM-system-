/**
 * Ask "Write content" and "Make an image" cards:
 * - content_writer writes from business context and never depends on web research
 * - imaging_generate answers plainly (no failure, no clarification) when a brief-only
 *   request arrives and no image provider is configured
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentConfigFindFirst: vi.fn(async () => ({
    brandTone: "Warm and friendly",
    emojiUsage: "minimal",
    bookingUrl: "https://book.example/glow",
  })),
  getBusinessProfile: vi.fn(async () => ({
    organisation: { name: "Glow Salon" },
    products: [
      { name: "Balayage colour", description: null, category: "Colour", priceMinCents: 13000, priceMaxCents: null, currency: "GBP" },
      { name: "Balayage colour", description: null, category: "Colour", priceMinCents: 13000, priceMaxCents: null, currency: "GBP" },
    ],
    audiences: [{ name: "Brides-to-be in Leeds" }],
    claims: [{ predicate: "location", valueText: "Leeds" }],
  })),
  retrieveRelevantKnowledge: vi.fn(async () => ({
    chunks: [
      "Cut and blow-dry from £50. Balayage from £130.",
      "Bridal hair trial from £75, booked 6–8 weeks before the wedding. Bridal party hair from £45 per person.",
    ],
    documentTitles: ["Price list"],
    mode: "lexical",
  })),
  completeStructuredSafe: vi.fn(async () => ({ ok: false, reason: "schema", failureClass: "SCHEMA_FAILED" })),
  hasWebSearchCredentials: vi.fn(() => false),
  webSearch: vi.fn(async () => [] as unknown[]),
  assertEntitlement: vi.fn(async () => ({ ok: true, used: null, limit: null })),
  assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
  createGeneratedAsset: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    agentConfiguration: { findFirst: mocks.agentConfigFindFirst },
    agentRun: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) },
  },
}));
vi.mock("@/services/digital-twin", () => ({ getBusinessProfile: mocks.getBusinessProfile }));
vi.mock("@/services/knowledge", () => ({ retrieveRelevantKnowledge: mocks.retrieveRelevantKnowledge }));
vi.mock("@/adapters/ai/structured", () => ({ completeStructuredSafe: mocks.completeStructuredSafe }));
vi.mock("@/adapters/sources/web", () => ({
  hasWebSearchCredentials: mocks.hasWebSearchCredentials,
  webSourceAdapter: { search: mocks.webSearch },
}));
vi.mock("@/services/entitlements", () => ({ assertEntitlement: mocks.assertEntitlement }));
vi.mock("@/services/ai-spend-gate", () => ({ assertWithinSpendCap: mocks.assertWithinSpendCap }));
vi.mock("@/services/assets", () => ({
  createGeneratedAsset: mocks.createGeneratedAsset,
  loadAssetBytes: vi.fn(async () => null),
}));

import {
  buildTemplateDraft,
  contentWriterAgent,
  detectContentFormat,
  extractContentTopic,
  pickKnowledgeLines,
  pickRelevantProducts,
} from "@/agents/content-writer";
import { imagingGenerateAgent } from "@/agents/imaging-generate";
import { isNonWebResearchOutput, looksLikeResearchOutput } from "@/agents/supervisor/research-deadline";
import { resetEnvCache } from "@/lib/env";

const ctx = { organisationId: "org_glow", agentRunId: "run_1", agentStepId: "step_1" };

describe("content_writer helpers", () => {
  it("extracts topic and format from card prompts", () => {
    expect(extractContentTopic("Write an Instagram post about our bridal hair packages")).toBe(
      "our bridal hair packages",
    );
    expect(extractContentTopic("Write content about our bridal hair packages")).toBe("our bridal hair packages");
    expect(extractContentTopic('Draft a caption for "Spring balayage offer"')).toBe("Spring balayage offer");
    expect(detectContentFormat("Write an Instagram post about X")).toBe("instagram_post");
    expect(detectContentFormat("Write a reel script about X")).toBe("reel_script");
    expect(detectContentFormat("Write a caption for X")).toBe("caption");
  });

  it("never presents an unrelated offering as the topic", () => {
    const products = [
      { name: "Balayage colour", description: "Hand-painted hair colour", category: null, priceMinCents: null, priceMaxCents: null, currency: null },
      { name: "Bridal hair trial", description: null, category: null, priceMinCents: 7500, priceMaxCents: null, currency: "GBP" },
    ];
    expect(pickRelevantProducts("our bridal hair packages", products).map((p) => p.name)).toEqual([
      "Bridal hair trial",
    ]);
    expect(pickRelevantProducts("our bridal hair packages", products.slice(0, 1))).toEqual([]);
  });

  it("quotes only knowledge lines about the topic", () => {
    expect(
      pickKnowledgeLines("bridal hair packages", [
        "Cut and blow-dry from £50. Balayage from £130.",
        "Bridal hair trial from £75. Opening hours: Mon-Sat.",
      ]),
    ).toEqual(["Bridal hair trial from £75."]);
  });

  it("template draft is grounded in business context", () => {
    const draft = buildTemplateDraft({
      topic: "our bridal hair packages",
      format: "instagram_post",
      ctx: {
        orgName: "Glow Salon",
        whatWeDo: null,
        location: "Leeds",
        products: [],
        otherProducts: [],
        audiences: ["Brides-to-be in Leeds"],
        brandTone: "Warm",
        emojiUsage: "minimal",
        bookingUrl: null,
        knowledgeSnippets: [],
        knowledgeLines: ["Bridal hair trial from £75."],
      },
    });
    expect(draft.caption).toMatch(/Thinking about bridal hair packages\?/);
    expect(draft.caption).toMatch(/At Glow Salon, we offer bridal hair packages/);
    expect(draft.caption).toMatch(/Bridal hair trial from £75\./);
    expect(draft.caption).toMatch(/Made for brides-to-be in Leeds\./);
    expect(draft.caption).not.toMatch(/Balayage/);
    expect(draft.hashtags).toContain("#bridal");
  });
});

describe("content_writer agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasWebSearchCredentials.mockReturnValue(false);
  });

  it("writes the post from business context when web research is unavailable, and says so", async () => {
    const { output } = await contentWriterAgent.execute(
      { request: "Write an Instagram post about our bridal hair packages" },
      ctx,
    );
    expect(mocks.webSearch).not.toHaveBeenCalled();
    expect(output.source).toBe("workspace_content");
    expect(output.researchUsed).toBe(false);
    expect(output.researchNote).toMatch(/not used — web research isn't available/);
    expect(output.summary).toMatch(/^INSTAGRAM POST — draft \(not posted\)/);
    expect(output.summary).toMatch(/Bridal hair trial from £75/);
    expect(output.summary).toMatch(/Research: not used/);
    expect(output.summary).not.toMatch(/Web research isn't available for this workspace right now/);
    expect(output.businessContextUsed.join(" ")).toMatch(/Glow Salon/);
    expect(output.businessContextUsed.join(" ")).toMatch(/brand tone “Warm and friendly”/);
    expect(output.generatedBy).toBe("template");
    expect(output.sources).toBeUndefined();
    // Built from the workspace's own data — the research quality gate must skip it.
    expect(isNonWebResearchOutput(output)).toBe(true);
    expect(looksLikeResearchOutput(output)).toBe(false);
  });

  it("uses the AI adapter draft (with brand tone and offerings in the prompt) when it returns one", async () => {
    mocks.completeStructuredSafe.mockResolvedValueOnce({
      ok: true,
      data: {
        hook: "Your wedding hair, sorted",
        caption: "Your wedding hair, sorted. Book a bridal trial with Glow Salon and walk down the aisle feeling like you.",
        hashtags: ["#leedsbride"],
        callToAction: "DM us 'BRIDE' to check your date",
      },
      repaired: false,
      raw: {},
    } as never);
    const { output } = await contentWriterAgent.execute(
      { request: "Write an Instagram post about our bridal hair packages" },
      ctx,
    );
    expect(output.generatedBy).toBe("ai");
    expect(output.summary).toMatch(/Book a bridal trial with Glow Salon/);
    expect(output.summary).toMatch(/Call to action: DM us 'BRIDE'/);
    const call = mocks.completeStructuredSafe.mock.calls[0] as unknown as [unknown, { system: string; prompt: string }];
    expect(call[1].system).toMatch(/Brand tone: Warm and friendly/);
    expect(call[1].prompt).toMatch(/Bridal hair trial from £75/);
    expect(call[1].prompt).toMatch(/Other offerings \(context only/);
  });

  it("falls back to business context when research returns nothing", async () => {
    mocks.hasWebSearchCredentials.mockReturnValue(true);
    mocks.webSearch.mockResolvedValueOnce([]);
    const { output } = await contentWriterAgent.execute(
      { request: "Write content about our bridal hair packages" },
      ctx,
    );
    expect(mocks.webSearch).toHaveBeenCalledTimes(1);
    expect(output.researchUsed).toBe(false);
    expect(output.researchNote).toMatch(/quick web scan returned nothing usable/);
    expect(output.summary).toMatch(/Thinking about bridal hair packages/);
  });

  it("adds light research sources when search returns results", async () => {
    mocks.hasWebSearchCredentials.mockReturnValue(true);
    mocks.webSearch.mockResolvedValueOnce([
      { url: "https://example.com/bridal-trends", title: "Bridal hair trends", content: "Soft waves are back", author: null, publishedAt: null, platform: "web", engagement: null, rawMetadata: {} },
    ]);
    const { output } = await contentWriterAgent.execute(
      { request: "Write content about our bridal hair packages" },
      ctx,
    );
    expect(output.researchUsed).toBe(true);
    expect(output.sources).toEqual([
      { url: "https://example.com/bridal-trends", title: "Bridal hair trends", platform: "web" },
    ]);
    // Still a content draft, not a web-research answer.
    expect(isNonWebResearchOutput(output)).toBe(true);
  });
});

describe("imaging_generate from a brief", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("returns a clear 'not set up' answer (no spend, no failure) when no provider is configured", async () => {
    vi.stubEnv("IMAGE_PROVIDER", "none");
    resetEnvCache();
    const { output, costCents } = await imagingGenerateAgent.execute(
      {
        prompt: "Promotional image: bridal hair promo. Square, social-media-ready image.",
        request: "Make something like this reference: bridal hair promo",
      },
      ctx,
    );
    expect(costCents).toBe(0);
    expect(mocks.assertWithinSpendCap).not.toHaveBeenCalled();
    expect(mocks.createGeneratedAsset).not.toHaveBeenCalled();
    expect(output).toMatchObject({ notConfigured: true });
    const o = output as { summary: string; shortAnswer: string };
    expect(o.shortAnswer).toMatch(/Image generation isn't set up for this workspace yet/);
    expect(o.summary).toMatch(/bridal hair promo/);
    expect(o.summary).toMatch(/No reference image was attached/);
    expect(isNonWebResearchOutput(output)).toBe(true);
  });

  it("keeps the existing error for the reference-confirm path", async () => {
    vi.stubEnv("IMAGE_PROVIDER", "none");
    resetEnvCache();
    await expect(
      imagingGenerateAgent.execute(
        { prompt: "A calm workspace with soft morning light", referenceAssetId: "asset_1" },
        ctx,
      ),
    ).rejects.toMatchObject({ userFacingMessage: expect.stringMatching(/isn't set up yet/) });
  });
});
