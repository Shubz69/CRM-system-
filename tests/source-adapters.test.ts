import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceNotConfiguredError,
  dedupeSourceResults,
  getSourceAdapter,
  rankSourceResults,
  type SourceResult,
} from "@/adapters/sources";
import {
  clearSourceCache,
  hashSourceQuery,
  setCachedSourceResults,
  getCachedSourceResults,
} from "@/adapters/sources/cache";
import { clearSourceRateLimits, tryAcquireRateLimit } from "@/adapters/sources/rate-limit";
import { resetEnvCache } from "@/lib/env";

describe("source adapters — stubs and config", () => {
  afterEach(() => {
    clearSourceCache();
    clearSourceRateLimits();
    vi.unstubAllEnvs();
    resetEnvCache();
    vi.resetModules();
  });

  it("Instagram / LinkedIn / TikTok throw explicit not-configured errors (no fake data)", async () => {
    for (const platform of ["instagram", "linkedin", "tiktok"] as const) {
      const adapter = getSourceAdapter(platform);
      await expect(
        adapter.search("anything", { organisationId: "org_1" }),
      ).rejects.toBeInstanceOf(SourceNotConfiguredError);
      await expect(adapter.search("anything", { organisationId: "org_1" })).rejects.toThrow(
        /not configured|licensed provider/i,
      );
    }
  });

  it("lists no configured platforms when all source API keys are unset", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "");
    vi.stubEnv("REDDIT_CLIENT_ID", "");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "");
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("EXA_API_KEY", "");
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.TAVILY_API_KEY;
    delete process.env.EXA_API_KEY;
    resetEnvCache();
    vi.resetModules();

    const { listConfiguredSourcePlatforms } = await import("@/adapters/sources");
    const platforms = listConfiguredSourcePlatforms();
    expect(platforms).toEqual([]);
    expect(platforms).not.toContain("instagram");
    expect(platforms).not.toContain("linkedin");
    expect(platforms).not.toContain("tiktok");
  });

  it("dedupes and ranks sources by engagement", () => {
    const a: SourceResult = {
      url: "https://example.com/a",
      title: "A",
      content: "a",
      author: null,
      publishedAt: new Date("2024-01-01"),
      platform: "web",
      engagement: { score: 10 },
      rawMetadata: {},
    };
    const b: SourceResult = {
      url: "https://example.com/b",
      title: "B",
      content: "b",
      author: null,
      publishedAt: new Date("2024-06-01"),
      platform: "web",
      engagement: { score: 50 },
      rawMetadata: {},
    };
    const dup: SourceResult = { ...a, title: "A-dup" };
    const ranked = rankSourceResults(dedupeSourceResults([a, dup, b]));
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.url).toBe("https://example.com/b");
  });

  it("caches by query hash with TTL semantics", () => {
    const key = hashSourceQuery({
      platform: "web",
      query: "plant hire",
      organisationId: "org_1",
    });
    setCachedSourceResults(
      key,
      [
        {
          url: "https://example.com/x",
          title: "X",
          content: "x",
          author: null,
          publishedAt: null,
          platform: "web",
          engagement: null,
          rawMetadata: {},
        },
      ],
      60_000,
    );
    expect(getCachedSourceResults(key)?.[0]?.url).toBe("https://example.com/x");
  });

  it("rate limiter rejects without sleeping when the window is full", () => {
    const key = "test:limiter";
    expect(tryAcquireRateLimit({ key, limit: 2, windowMs: 60_000 })).toBe(true);
    expect(tryAcquireRateLimit({ key, limit: 2, windowMs: 60_000 })).toBe(true);
    expect(tryAcquireRateLimit({ key, limit: 2, windowMs: 60_000 })).toBe(false);
  });
});
