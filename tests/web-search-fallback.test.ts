import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/adapters/sources/rate-limit", () => ({
  tryAcquireRateLimit: () => true,
}));

vi.mock("@/adapters/sources/cache", () => ({
  hashSourceQuery: () => "cache-key",
  getCachedSourceResults: () => null,
  setCachedSourceResults: () => undefined,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const envState = {
  WEB_SEARCH_PROVIDER: "tavily" as "tavily" | "exa",
  TAVILY_API_KEY: "tvly-test",
  EXA_API_KEY: "exa-test" as string | undefined,
  WEB_SEARCH_RATE_LIMIT_PER_MIN: "40",
};

vi.mock("@/lib/env", () => ({
  getEnv: () => envState,
}));

describe("web search provider fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    envState.WEB_SEARCH_PROVIDER = "tavily";
    envState.TAVILY_API_KEY = "tvly-test";
    envState.EXA_API_KEY = "exa-test";
  });

  it("falls back to Exa when primary returns quota/availability failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 432,
        text: async () => JSON.stringify({ detail: { error: "usage limit" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              url: "https://example.com/coo",
              title: "COO profile",
              text: "Operations leader at a UK SaaS company",
              score: 0.9,
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { searchWebWithFallback } = await import("@/adapters/sources/web");
    const results = await searchWebWithFallback("UK SaaS COO", {
      organisationId: "org_1",
      limit: 5,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://example.com/coo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("tavily.com");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("exa.ai");
  });

  it("does not fall back when primary succeeds with empty results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchWebWithFallback } = await import("@/adapters/sources/web");
    const results = await searchWebWithFallback("obscure query", {
      organisationId: "org_1",
      limit: 5,
    });
    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces provider-agnostic unavailable errors (no vendor names)", async () => {
    envState.EXA_API_KEY = undefined;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 432,
      text: async () => "plan usage limit Tavily",
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchWebWithFallback } = await import("@/adapters/sources/web");
    const { SourceUnavailableError } = await import("@/adapters/sources/types");
    await expect(
      searchWebWithFallback("test", { organisationId: "org_1", limit: 3 }),
    ).rejects.toBeInstanceOf(SourceUnavailableError);

    try {
      await searchWebWithFallback("test", { organisationId: "org_1", limit: 3 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message.toLowerCase()).not.toMatch(/tavily|exa|432|apify/);
      expect(message).toMatch(/web research/i);
    }
  });

  it("classifies quota HTTP statuses as availability failures", async () => {
    const { isWebProviderAvailabilityFailure } = await import("@/adapters/sources/web");
    expect(isWebProviderAvailabilityFailure(new Error("Web search primary failed (432): usage"))).toBe(
      true,
    );
    expect(isWebProviderAvailabilityFailure(new Error("empty results"))).toBe(false);
  });
});
