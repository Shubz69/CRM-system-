import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SourceNotConfiguredError,
  SourceUnavailableError,
  formatUnavailableSourceNotes,
  getSourceAdapter,
} from "@/adapters/sources";
import {
  clearSourceCache,
  hashSourceQuery,
  setCachedSourceResults,
  getCachedSourceResults,
} from "@/adapters/sources/cache";
import { clearSourceRateLimits } from "@/adapters/sources/rate-limit";
import { resetEnvCache } from "@/lib/env";
import {
  INSTAGRAM_APIFY_CONFIG,
  LINKEDIN_APIFY_CONFIG,
  TIKTOK_APIFY_CONFIG,
} from "@/adapters/sources/apify-platforms";
import { toApifyActorPath } from "@/adapters/sources/apify-client";

vi.mock("@/services/ai-spend-gate", () => ({
  assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
  SpendCapExceededError: class SpendCapExceededError extends Error {},
}));

vi.mock("@/adapters/sources/apify-billing", () => ({
  recordApifySpend: vi.fn(async () => undefined),
  addBillableCents: (sink: { value: number } | undefined, cents: number) => {
    if (!sink) return;
    sink.value += Math.max(0, Math.round(cents));
  },
}));

function stubApifyFetchSequence(
  handlers: Array<(url: string, init?: RequestInit) => Promise<Response> | Response>,
) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const handler = handlers[i++];
      if (!handler) {
        throw new Error(`Unexpected fetch #${i} → ${url}`);
      }
      return handler(url, init);
    }),
  );
}

describe("Apify source adapters", () => {
  beforeEach(() => {
    clearSourceCache();
    clearSourceRateLimits();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  afterEach(() => {
    clearSourceCache();
    clearSourceRateLimits();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetEnvCache();
    vi.resetModules();
  });

  it("throws SourceNotConfiguredError when APIFY_TOKEN is unset (no fake data)", async () => {
    delete process.env.APIFY_TOKEN;
    resetEnvCache();
    for (const platform of ["instagram", "linkedin", "tiktok"] as const) {
      const adapter = getSourceAdapter(platform);
      await expect(
        adapter.search("plant hire", { organisationId: "org_a" }),
      ).rejects.toBeInstanceOf(SourceNotConfiguredError);
    }
  });

  it("lists IG/LinkedIn/TikTok only when APIFY_TOKEN is set", async () => {
    delete process.env.APIFY_TOKEN;
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.TAVILY_API_KEY;
    delete process.env.EXA_API_KEY;
    resetEnvCache();
    vi.resetModules();

    const { listConfiguredSourcePlatforms: listA } = await import("@/adapters/sources");
    expect(listA()).not.toContain("instagram");

    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();
    vi.resetModules();
    const { listConfiguredSourcePlatforms: listB } = await import("@/adapters/sources");
    const platforms = listB();
    expect(platforms).toEqual(expect.arrayContaining(["instagram", "linkedin", "tiktok"]));
  });

  it("maps Instagram actor items and records billable cost", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();

    stubApifyFetchSequence([
      () =>
        Response.json({
          data: { id: "run_ig_1", status: "RUNNING", defaultDatasetId: "ds_ig" },
        }),
      () =>
        Response.json({
          data: {
            id: "run_ig_1",
            status: "SUCCEEDED",
            defaultDatasetId: "ds_ig",
            usageTotalUsd: 0.05,
          },
        }),
      () =>
        Response.json([
          {
            url: "https://www.instagram.com/p/ABC123/",
            shortCode: "ABC123",
            caption: "Great excavator for hire in Leeds",
            ownerUsername: "plantco",
            likesCount: 42,
            commentsCount: 3,
            timestamp: "2026-08-01T12:00:00.000Z",
          },
        ]),
    ]);

    const billable = { value: 0 };
    const adapter = getSourceAdapter("instagram");
    const results = await adapter.search("excavator hire", {
      organisationId: "org_a",
      limit: 5,
      _billableCents: billable,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.platform).toBe("instagram");
    expect(results[0]?.author).toBe("plantco");
    expect(results[0]?.engagement?.likes).toBe(42);
    expect(results[0]?.url).toContain("ABC123");
    expect(billable.value).toBeGreaterThan(0);
  });

  it("surfaces plain-English SourceUnavailableError on actor failure (no actor ids)", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();

    stubApifyFetchSequence([
      () =>
        Response.json({
          data: { id: "run_fail", status: "RUNNING", defaultDatasetId: "ds_x" },
        }),
      () =>
        Response.json({
          data: { id: "run_fail", status: "FAILED", defaultDatasetId: "ds_x" },
        }),
    ]);

    const adapter = getSourceAdapter("linkedin");
    await expect(
      adapter.search("b2b sales", { organisationId: "org_a", limit: 3 }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(SourceUnavailableError);
      const msg = (error as Error).message;
      expect(msg).toMatch(/LinkedIn results were unavailable/i);
      expect(msg).not.toMatch(/apify|harvestapi|actor/i);
      return true;
    });
  });

  it("searchConfiguredSources continues when LinkedIn fails and others succeed", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();
    vi.resetModules();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("linkedin") && url.includes("/runs?")) {
        return Response.json({
          data: { id: "run_li", status: "RUNNING", defaultDatasetId: "ds_li" },
        });
      }
      if (url.includes("actor-runs/run_li")) {
        return Response.json({
          data: { id: "run_li", status: "FAILED", defaultDatasetId: "ds_li" },
        });
      }
      if (url.includes("instagram") && url.includes("/runs?")) {
        return Response.json({
          data: { id: "run_ig", status: "RUNNING", defaultDatasetId: "ds_ig" },
        });
      }
      if (url.includes("actor-runs/run_ig")) {
        return Response.json({
          data: {
            id: "run_ig",
            status: "SUCCEEDED",
            defaultDatasetId: "ds_ig",
            usageTotalUsd: 0.02,
          },
        });
      }
      if (url.includes("/datasets/ds_ig/items")) {
        return Response.json([
          {
            url: "https://www.instagram.com/p/OK1/",
            caption: "ok",
            ownerUsername: "u",
            likesCount: 1,
          },
        ]);
      }
      if (url.includes("tiktok") && url.includes("/runs?")) {
        return Response.json({
          data: { id: "run_tt", status: "RUNNING", defaultDatasetId: "ds_tt" },
        });
      }
      if (url.includes("actor-runs/run_tt")) {
        return Response.json({
          data: {
            id: "run_tt",
            status: "SUCCEEDED",
            defaultDatasetId: "ds_tt",
            usageTotalUsd: 0.01,
          },
        });
      }
      if (url.includes("/datasets/ds_tt/items")) {
        return Response.json([
          {
            webVideoUrl: "https://www.tiktok.com/@x/video/1",
            text: "tiktok hit",
            authorMeta: { name: "x" },
            diggCount: 9,
            playCount: 100,
          },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchConfiguredSources } = await import("@/adapters/sources");
    const { results, errors, billableCents } = await searchConfiguredSources({
      query: "hire",
      platforms: ["instagram", "linkedin", "tiktok"],
      concurrency: 3,
      options: { organisationId: "org_a", limit: 3 },
    });

    expect(results.some((r) => r.platform === "instagram")).toBe(true);
    expect(results.some((r) => r.platform === "tiktok")).toBe(true);
    expect(results.every((r) => r.platform !== "linkedin")).toBe(true);
    expect(errors.some((e) => e.platform === "linkedin")).toBe(true);
    expect(errors.find((e) => e.platform === "linkedin")?.message).toMatch(
      /LinkedIn results were unavailable/i,
    );
    expect(billableCents).toBeGreaterThan(0);
  });

  it("keeps query-hash cache org-scoped (cross-org isolation)", () => {
    const keyA = hashSourceQuery({
      platform: "instagram",
      query: "same query",
      organisationId: "org_a",
      options: { limit: 5 },
    });
    const keyB = hashSourceQuery({
      platform: "instagram",
      query: "same query",
      organisationId: "org_b",
      options: { limit: 5 },
    });
    expect(keyA).not.toBe(keyB);

    setCachedSourceResults(
      keyA,
      [
        {
          url: "https://www.instagram.com/p/A/",
          title: "A only",
          content: "secret-a",
          author: null,
          publishedAt: null,
          platform: "instagram",
          engagement: null,
          rawMetadata: {},
        },
      ],
      60_000,
    );
    expect(getCachedSourceResults(keyA)?.[0]?.content).toBe("secret-a");
    expect(getCachedSourceResults(keyB)).toBeNull();
  });

  it("formatUnavailableSourceNotes strips provider jargon", () => {
    const notes = formatUnavailableSourceNotes([
      {
        platform: "instagram",
        message: "Instagram results were unavailable for this search.",
        code: "SOURCE_UNAVAILABLE",
      },
      {
        platform: "linkedin",
        message: "Apify actor harvestapi/linkedin-post-search failed",
        code: "SOURCE_UNAVAILABLE",
      },
      {
        platform: "web",
        message: "missing key",
        code: "SOURCE_NOT_CONFIGURED",
      },
    ]);
    expect(notes).toContain("Instagram results were unavailable for this search.");
    expect(notes.some((n) => /LinkedIn results were unavailable/i.test(n))).toBe(true);
    expect(notes.join(" ")).not.toMatch(/harvestapi|apify actor/i);
    expect(notes.every((n) => !/missing key/.test(n))).toBe(true);
  });

  it("documents recommended actor ids and converts path form", () => {
    expect(INSTAGRAM_APIFY_CONFIG.defaultActorId).toBe("apify/instagram-scraper");
    expect(TIKTOK_APIFY_CONFIG.defaultActorId).toBe("clockworks/tiktok-scraper");
    expect(LINKEDIN_APIFY_CONFIG.defaultActorId).toBe("harvestapi/linkedin-post-search");
    expect(toApifyActorPath("apify/instagram-scraper")).toBe("apify~instagram-scraper");
  });
});
