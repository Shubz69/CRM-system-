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

  it("throws AUTH_REQUIRED with Vercel key names when Tavily and Exa are unset", async () => {
    envState.TAVILY_API_KEY = undefined;
    envState.EXA_API_KEY = undefined;
    const { searchWebWithFallback } = await import("@/adapters/sources/web");
    const { SourceAuthRequiredError } = await import("@/adapters/sources/types");
    await expect(
      searchWebWithFallback("Research plant hire UK pricing", { organisationId: "org_1", limit: 5 }),
    ).rejects.toBeInstanceOf(SourceAuthRequiredError);
    try {
      await searchWebWithFallback("Research plant hire UK pricing", { organisationId: "org_1" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/research isn't available|enable research search/i);
      expect(message).not.toMatch(/TAVILY_API_KEY|EXA_API_KEY|Vercel|Railway|AUTH_REQUIRED/i);
    }
  });

  it("returns plant-hire URL + snippet on the mocked Tavily success path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            url: "https://hire.example/rates",
            title: "UK plant hire day rates",
            content: "A 3-tonne excavator typically hires from £120 per day in the UK.",
            score: 0.91,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchWebWithFallback } = await import("@/adapters/sources/web");
    const results = await searchWebWithFallback("Research plant hire UK pricing", {
      organisationId: "org_1",
      limit: 5,
      qualityBudget: "FAST",
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://hire.example/rates");
    expect(results[0]?.content).toMatch(/£120 per day/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("tavily.com");
  });

  it("maps 401 to AUTH_REQUIRED when no fallback key is configured", async () => {
    envState.EXA_API_KEY = undefined;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid api key",
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchWebWithFallback } = await import("@/adapters/sources/web");
    const { SourceAuthRequiredError } = await import("@/adapters/sources/types");
    await expect(
      searchWebWithFallback("plant hire", { organisationId: "org_1", limit: 3 }),
    ).rejects.toBeInstanceOf(SourceAuthRequiredError);
  });

  it("falls back to Exa on FAST when Tavily returns 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              url: "https://hire.example/rates",
              title: "UK plant hire day rates",
              text: "A 3-tonne excavator typically hires from £120 per day in the UK.",
              score: 0.88,
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { searchWebWithFallback } = await import("@/adapters/sources/web");
    const results = await searchWebWithFallback("Research plant hire UK pricing", {
      organisationId: "org_1",
      limit: 5,
      qualityBudget: "FAST",
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://hire.example/rates");
    expect(results[0]?.content).toMatch(/£120/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("exa.ai");
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
    expect(isWebProviderAvailabilityFailure(new Error("The operation was aborted"))).toBe(true);
  });

  it("aborts a hung primary fetch and skips Exa fallback on FAST", async () => {
    const fetchMock = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const fail = () =>
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail);
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    const { searchWebWithFallback } = await import("@/adapters/sources/web");
    await expect(
      searchWebWithFallback("UK plant hire", {
        organisationId: "org_1",
        limit: 3,
        timeoutMs: 80,
        qualityBudget: "FAST",
      }),
    ).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
