import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceNotConfiguredError, getSourceAdapter, listConfiguredSourcePlatforms } from "@/adapters/sources";
import { clearSourceCache } from "@/adapters/sources/cache";
import { clearSourceRateLimits } from "@/adapters/sources/rate-limit";
import { resetEnvCache } from "@/lib/env";
import { THREADS_APIFY_CONFIG, TWITTER_APIFY_CONFIG } from "@/adapters/sources/apify-platforms";

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

vi.mock("@/lib/db", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(async () => ({ key: "apify.enabled", value: { enabled: true } })),
      upsert: vi.fn(async () => ({ key: "apify.enabled", value: { enabled: true } })),
    },
    organisationPreference: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => null),
    },
    researchSource: { findMany: vi.fn(async () => []) },
    researchSourceSnapshot: { findMany: vi.fn(async () => []) },
  },
}));

function stubApifyFetchSequence(
  handlers: Array<(url: string, init?: RequestInit) => Promise<Response> | Response>,
) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const handler = handlers[i++];
      if (!handler) throw new Error(`Unexpected fetch #${i} → ${url}`);
      return handler(url);
    }),
  );
}

describe("Twitter/X and Threads Apify source adapters", () => {
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

  it("throws SourceNotConfiguredError when APIFY_TOKEN is unset", async () => {
    delete process.env.APIFY_TOKEN;
    resetEnvCache();
    for (const platform of ["twitter", "threads"] as const) {
      await expect(
        getSourceAdapter(platform).search("plant hire", { organisationId: "org_a" }),
      ).rejects.toBeInstanceOf(SourceNotConfiguredError);
    }
  });

  it("lists twitter and threads once APIFY_TOKEN is set", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();
    vi.resetModules();
    const { listConfiguredSourcePlatforms: list } = await import("@/adapters/sources");
    expect(list()).toEqual(expect.arrayContaining(["twitter", "threads"]));
  });

  it("maps a Tweet Scraper V2 item correctly", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();

    stubApifyFetchSequence([
      () => Response.json({ data: { id: "run_tw", status: "RUNNING", defaultDatasetId: "ds_tw" } }),
      () =>
        Response.json({
          data: { id: "run_tw", status: "SUCCEEDED", defaultDatasetId: "ds_tw", usageTotalUsd: 0.01 },
        }),
      () =>
        Response.json([
          {
            url: "https://x.com/plantco/status/12345",
            text: "Excavators available in Leeds this week",
            author: { userName: "plantco" },
            likeCount: 12,
            replyCount: 2,
            retweetCount: 4,
            viewCount: 900,
            createdAt: "2026-08-01T12:00:00.000Z",
          },
        ]),
    ]);

    const adapter = getSourceAdapter("twitter");
    const results = await adapter.search("excavator hire", { organisationId: "org_a", limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]?.platform).toBe("twitter");
    expect(results[0]?.author).toBe("plantco");
    expect(results[0]?.engagement?.likes).toBe(12);
    expect(results[0]?.engagement?.shares).toBe(4);
  });

  it("maps a Threads search-mode item correctly", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();

    stubApifyFetchSequence([
      () => Response.json({ data: { id: "run_th", status: "RUNNING", defaultDatasetId: "ds_th" } }),
      () =>
        Response.json({
          data: { id: "run_th", status: "SUCCEEDED", defaultDatasetId: "ds_th", usageTotalUsd: 0.02 },
        }),
      () =>
        Response.json([
          {
            url: "https://www.threads.net/@plantco/post/123",
            text: "New diggers in stock",
            username: "plantco",
            likeCount: 7,
            replyCount: 1,
            repostCount: 0,
            timestamp: "2026-08-02T09:00:00.000Z",
          },
        ]),
    ]);

    const adapter = getSourceAdapter("threads");
    const results = await adapter.search("diggers", { organisationId: "org_a", limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]?.platform).toBe("threads");
    expect(results[0]?.author).toBe("plantco");
    expect(results[0]?.engagement?.likes).toBe(7);
  });

  it("documents recommended actor ids for review before production lock-in", () => {
    expect(TWITTER_APIFY_CONFIG.defaultActorId).toBe("apidojo/tweet-scraper");
    expect(THREADS_APIFY_CONFIG.defaultActorId).toBe("automation-lab/threads-scraper");
  });
});
