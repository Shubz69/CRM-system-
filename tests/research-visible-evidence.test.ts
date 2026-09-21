import { describe, expect, it } from "vitest";
import { deterministicResearchBrief } from "@/lib/research-visible-evidence";
import { sanitizeAskClientPayload } from "@/lib/customer-ai-errors";

describe("deterministicResearchBrief", () => {
  it("turns content-idea topics into numbered source-backed angles", () => {
    const brief = deterministicResearchBrief("Give me three content ideas for Tonaura.", [
      {
        url: "https://sparktoro.com/blog/audience",
        title: "Audience research for niche brands",
        content: "Founders over-index on vanity metrics.",
      },
      {
        url: "https://businessnewsdaily.com/wellness",
        title: "Wellness studio conversion trends",
        content: "Calm landing pages outperform feature dumps.",
      },
      {
        url: "https://example.com/retainers",
        title: "Advisory retainers in premium wellness",
        content: "Studios buy outcomes, not websites.",
      },
    ]);
    expect(brief).toMatch(/Source-backed content angles/i);
    expect(brief).toMatch(/1\./);
    expect(brief).toMatch(/sparktoro.com/);
    expect(brief).not.toMatch(/Evidence scan/i);
    expect(brief).not.toMatch(/\b(tavily|exa|anthropic)\b/i);
  });
});

describe("sanitizeAskClientPayload", () => {
  it("strips registered tool catalogs and vendor names", () => {
    const out = sanitizeAskClientPayload({
      kernel: {
        registeredTools: [{ name: "tavily.search_web", description: "uses embeddings" }],
        toolsInvoked: [{ toolName: "tavily.search_web", error: "Tavily HTTP 432 quota" }],
      },
      finalOutput: { adapterErrors: [{ platform: "web", message: "exa fallback used" }] },
    });
    expect(out.kernel?.registeredTools).toBeUndefined();
    expect(out.kernel?.toolsInvoked?.[0]?.toolName).toBe("web.search_web");
    expect(JSON.stringify(out)).not.toMatch(/\b(tavily|exa|embedding)\b/i);
  });
});
