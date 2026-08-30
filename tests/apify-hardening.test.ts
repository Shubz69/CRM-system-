/**
 * Part 4 — Essential Apify hardening. No real Actor calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSourceCache } from "@/adapters/sources/cache";
import { clearSourceRateLimits } from "@/adapters/sources/rate-limit";
import { resetEnvCache } from "@/lib/env";
import {
  ApifyDeniedError,
  assertApifyKillSwitchAllows,
  assertProxyPolicy,
  buildApifyProvenanceMetadata,
  clearApifyKillSwitchCache,
  clampApifyMaxItems,
  estimateMaxTotalChargeUsd,
  findFreshPersistentApifyCache,
  hashApifyCanonicalQuery,
  resolveApifyProgressiveLimit,
} from "@/adapters/sources/apify-hardening";
import {
  assertApprovedApifyActor,
  createApifySourceAdapter,
  INSTAGRAM_APIFY_CONFIG,
  isApprovedApifyActor,
  LINKEDIN_APIFY_CONFIG,
  resolveActorId,
} from "@/adapters/sources/apify-platforms";
import { buildApifyRunQuery } from "@/adapters/sources/apify-client";
import {
  collectCheapestSufficientSources,
  SOURCE_COST_TIER_ORDER,
} from "@/adapters/sources/source-ordering";

const systemSettingStore = new Map<string, unknown>();
const orgPrefStore = new Map<string, unknown>();
const researchSourceRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        if (!systemSettingStore.has(where.key)) return null;
        return { key: where.key, value: systemSettingStore.get(where.key) };
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { key: string };
          create: { key: string; value: unknown };
          update: { value: unknown };
        }) => {
          const value = systemSettingStore.has(where.key) ? update.value : create.value;
          systemSettingStore.set(where.key, value);
          return { key: where.key, value };
        },
      ),
    },
    organisationPreference: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { organisationId_key: { organisationId: string; key: string } };
        }) => {
          const k = `${where.organisationId_key.organisationId}:${where.organisationId_key.key}`;
          if (!orgPrefStore.has(k)) return null;
          return {
            organisationId: where.organisationId_key.organisationId,
            key: where.organisationId_key.key,
            value: orgPrefStore.get(k),
          };
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { organisationId_key: { organisationId: string; key: string } };
          create: { organisationId: string; key: string; value: unknown };
          update: { value: unknown };
        }) => {
          const k = `${where.organisationId_key.organisationId}:${where.organisationId_key.key}`;
          const value = orgPrefStore.has(k) ? update.value : create.value;
          orgPrefStore.set(k, value);
          return { organisationId: create.organisationId, key: create.key, value };
        },
      ),
    },
    researchSource: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const orgId = where.organisationId;
        const platform = where.platform;
        return researchSourceRows.filter(
          (r) => r.organisationId === orgId && r.platform === platform,
        );
      }),
    },
    researchSourceSnapshot: {
      findMany: vi.fn(async () => []),
    },
  },
}));

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

describe("Apify hardening (Part 4)", () => {
  beforeEach(() => {
    clearSourceCache();
    clearSourceRateLimits();
    clearApifyKillSwitchCache();
    systemSettingStore.clear();
    orgPrefStore.clear();
    researchSourceRows.length = 0;
    vi.unstubAllEnvs();
    resetEnvCache();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    clearSourceCache();
    clearSourceRateLimits();
    clearApifyKillSwitchCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetEnvCache();
  });

  it("denies unknown Actor IDs (no arbitrary Store Actors)", () => {
    expect(isApprovedApifyActor("apify/instagram-scraper")).toBe(true);
    expect(isApprovedApifyActor("someone/random-store-actor")).toBe(false);
    expect(() =>
      assertApprovedApifyActor("instagram", "someone/random-store-actor"),
    ).toThrow(ApifyDeniedError);
    try {
      assertApprovedApifyActor("instagram", "evil/scraper");
    } catch (error) {
      expect(error).toBeInstanceOf(ApifyDeniedError);
      expect((error as ApifyDeniedError).reason).toBe("UNKNOWN_ACTOR");
    }
  });

  it("denies env Actor overrides that are not on the allowlist", () => {
    vi.stubEnv("APIFY_INSTAGRAM_ACTOR_ID", "random/unapproved-actor");
    resetEnvCache();
    expect(() => resolveActorId(INSTAGRAM_APIFY_CONFIG)).toThrow(ApifyDeniedError);
  });

  it("denies disabled platform configs", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();
    const adapter = createApifySourceAdapter({
      ...INSTAGRAM_APIFY_CONFIG,
      enabled: false,
    });
    await expect(
      adapter.search("hire", { organisationId: "org_a", limit: 3 }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ApifyDeniedError);
      expect((error as ApifyDeniedError).reason).toBe("DISABLED");
      return true;
    });
  });

  it("honours persistent kill switch (DB authoritative, no process.exit)", async () => {
    const { setApifyGlobalEnabled, isApifyEnabled } = await import(
      "@/adapters/sources/apify-hardening"
    );
    await setApifyGlobalEnabled(false);
    expect(await isApifyEnabled("org_a")).toBe(false);
    await expect(assertApifyKillSwitchAllows("instagram", "org_a")).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(ApifyDeniedError);
        expect((error as ApifyDeniedError).reason).toBe("KILL_SWITCH");
        return true;
      },
    );

    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = createApifySourceAdapter(INSTAGRAM_APIFY_CONFIG);
    await expect(
      adapter.search("hire", { organisationId: "org_a", limit: 3 }),
    ).rejects.toBeInstanceOf(ApifyDeniedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("applies hard run options: maxItems, maxTotalChargeUsd, memory, timeout, build", () => {
    const query = buildApifyRunQuery({
      maxItems: 5,
      maxTotalChargeUsd: 0.05,
      memory: 2048,
      timeoutSecs: 60,
      build: "0.1.2",
    });
    const params = new URLSearchParams(query);
    expect(params.get("maxItems")).toBe("5");
    expect(params.get("maxTotalChargeUsd")).toBe("0.05");
    expect(params.get("memory")).toBe("2048");
    expect(params.get("timeout")).toBe("60");
    expect(params.get("build")).toBe("0.1.2");
    expect(params.get("waitForFinish")).toBe("0");

    expect(clampApifyMaxItems(100, INSTAGRAM_APIFY_CONFIG.hardMaxItems)).toBe(
      INSTAGRAM_APIFY_CONFIG.hardMaxItems,
    );
    expect(estimateMaxTotalChargeUsd({ estimatedUnitCost: 2.7, maxItems: 8 })).toBeGreaterThan(
      0,
    );
  });

  it("pins build and timeout from platform config into live run start URL", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();
    systemSettingStore.set("apify.enabled", { enabled: true });

    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/runs?")) {
          return Response.json({
            data: {
              id: "run_pin",
              status: "SUCCEEDED",
              defaultDatasetId: "ds_pin",
              usageTotalUsd: 0.02,
              buildNumber: "42",
            },
          });
        }
        if (url.includes("/datasets/")) {
          return Response.json([
            {
              url: "https://www.instagram.com/p/PIN1/",
              caption: "pinned",
              ownerUsername: "u",
              likesCount: 1,
            },
          ]);
        }
        return Response.json({
          data: {
            id: "run_pin",
            status: "SUCCEEDED",
            defaultDatasetId: "ds_pin",
            usageTotalUsd: 0.02,
            buildNumber: "42",
          },
        });
      }),
    );

    const adapter = createApifySourceAdapter({
      ...INSTAGRAM_APIFY_CONFIG,
      build: "1.2.3",
      timeout: 45_000,
      memoryMb: 1024,
    });
    await adapter.search("excavator", { organisationId: "org_a", limit: 3 });

    const startUrl = urls.find((u) => u.includes("/runs?"));
    expect(startUrl).toBeTruthy();
    expect(startUrl).toContain("build=1.2.3");
    expect(startUrl).toContain("timeout=45");
    expect(startUrl).toContain("memory=1024");
    expect(startUrl).toMatch(/maxItems=\d+/);
    expect(startUrl).toContain("maxTotalChargeUsd=");
  });

  it("persistent cache hit prevents paid Apify run", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();
    systemSettingStore.set("apify.enabled", { enabled: true });

    const limit = resolveApifyProgressiveLimit({
      defaultMaxItems: INSTAGRAM_APIFY_CONFIG.defaultMaxItems,
      hardMaxItems: INSTAGRAM_APIFY_CONFIG.hardMaxItems,
      requestedLimit: 3,
    });
    const hash = hashApifyCanonicalQuery({
      organisationId: "org_a",
      platform: "instagram",
      query: "plant hire",
      actorId: INSTAGRAM_APIFY_CONFIG.actorId,
      limit,
      recent: true,
    });

    researchSourceRows.push({
      organisationId: "org_a",
      platform: "instagram",
      url: "https://www.instagram.com/p/CACHED1/",
      title: "cached",
      author: "cachebot",
      publishedAt: new Date("2026-08-01T00:00:00Z"),
      content: "from persistent cache",
      engagement: { likes: 9 },
      rawMetadata: { canonicalQueryHash: hash },
      retrievedAt: new Date(),
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = createApifySourceAdapter(INSTAGRAM_APIFY_CONFIG);
    const results = await adapter.search("plant hire", {
      organisationId: "org_a",
      limit: 3,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.url).toContain("CACHED1");
    expect(results[0]?.rawMetadata.persistentCacheHit).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const hit = await findFreshPersistentApifyCache({
      organisationId: "org_a",
      platform: "instagram",
      canonicalQueryHash: hash,
      limit: 3,
    });
    expect(hit?.length).toBe(1);
  });

  it("attaches provenance while preserving factual source platform", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test_token");
    resetEnvCache();
    systemSettingStore.set("apify.enabled", { enabled: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/runs?")) {
          return Response.json({
            data: {
              id: "run_prov",
              status: "SUCCEEDED",
              defaultDatasetId: "ds_prov",
              usageTotalUsd: 0.07,
              buildNumber: "9",
            },
          });
        }
        if (url.includes("/datasets/")) {
          return Response.json([
            {
              url: "https://www.instagram.com/p/PROV1/",
              caption: "provenance post",
              ownerUsername: "plantco",
              likesCount: 4,
            },
          ]);
        }
        return Response.json({
          data: {
            id: "run_prov",
            status: "SUCCEEDED",
            defaultDatasetId: "ds_prov",
            usageTotalUsd: 0.07,
            buildNumber: "9",
          },
        });
      }),
    );

    const adapter = createApifySourceAdapter(INSTAGRAM_APIFY_CONFIG);
    const results = await adapter.search("provenance", {
      organisationId: "org_a",
      limit: 2,
    });
    const meta = results[0]?.rawMetadata ?? {};
    expect(results[0]?.platform).toBe("instagram");
    expect(meta.sourcePlatform).toBe("instagram");
    expect(meta.retrievalMechanism).toBe("apify");
    expect(meta.apify).toMatchObject({
      actorId: "apify/instagram-scraper",
      runId: "run_prov",
      actorBuild: "9",
    });
    expect((meta.apify as { inputHash: string }).inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect((meta.apify as { actualCost: { usageTotalUsd: number } }).actualCost.usageTotalUsd).toBe(
      0.07,
    );

    const built = buildApifyProvenanceMetadata({
      existing: { shortCode: "X" },
      provenance: {
        sourcePlatform: "instagram",
        retrievalMechanism: "apify",
        canonicalQueryHash: "abc",
        actorId: "apify/instagram-scraper",
        actorBuild: "latest",
        runId: "r1",
        inputHash: "deadbeef",
        retrievedAt: "2026-08-30T00:00:00.000Z",
        actualCost: { usageTotalUsd: 0.01, costCents: 1 },
      },
    });
    expect(built.sourcePlatform).toBe("instagram");
    expect(built.retrievalMechanism).toBe("apify");
  });

  it("enforces proxy policy — no social-session cookies; no residential default", () => {
    expect(INSTAGRAM_APIFY_CONFIG.proxyPolicy).toBe("DATACENTER");
    expect(LINKEDIN_APIFY_CONFIG.proxyPolicy).not.toBe("RESIDENTIAL_REQUIRED");

    expect(() =>
      assertProxyPolicy("instagram", "DATACENTER", { cookies: "sessionid=abc" }),
    ).toThrow(ApifyDeniedError);

    expect(() =>
      assertProxyPolicy("instagram", "NONE", { resultsLimit: 3 }),
    ).not.toThrow();
  });

  it("cheapest-sufficient ordering stops when evidence is enough", async () => {
    expect(SOURCE_COST_TIER_ORDER[0]).toBe("verified_evidence");
    expect(SOURCE_COST_TIER_ORDER.at(-1)).toBe("browser_proxy_actor");

    const tried: string[] = [];
    const result = await collectCheapestSufficientSources({
      minItems: 1,
      tiers: [
        {
          tier: "verified_evidence",
          fetch: async () => {
            tried.push("verified_evidence");
            return { items: [{ id: "v1" }] };
          },
        },
        {
          tier: "apify_approved_low_cost",
          fetch: async () => {
            tried.push("apify_approved_low_cost");
            return { items: [{ id: "a1" }] };
          },
        },
        {
          tier: "browser_proxy_actor",
          fetch: async () => {
            tried.push("browser_proxy_actor");
            return { items: [{ id: "b1" }] };
          },
        },
      ],
    });

    expect(result.sufficient).toBe(true);
    expect(result.stoppedAt).toBe("verified_evidence");
    expect(tried).toEqual(["verified_evidence"]);
    expect(result.tiersTried).not.toContain("apify_approved_low_cost");
  });

  it("progressive depth keeps small samples until broaden is requested", () => {
    const quick = resolveApifyProgressiveLimit({
      defaultMaxItems: 8,
      hardMaxItems: 25,
      requestedLimit: 20,
      answerMode: "QUICK",
      qualityBudget: "FAST",
      governorMode: "ECONOMY",
    });
    expect(quick).toBeLessThanOrEqual(3);

    const deep = resolveApifyProgressiveLimit({
      defaultMaxItems: 8,
      hardMaxItems: 25,
      requestedLimit: 20,
      answerMode: "DEEP",
      qualityBudget: "DEEP",
      governorMode: "DEEP",
    });
    expect(deep).toBe(8);

    const broadened = resolveApifyProgressiveLimit({
      defaultMaxItems: 8,
      hardMaxItems: 25,
      requestedLimit: 20,
      answerMode: "QUICK",
      broaden: true,
    });
    expect(broadened).toBe(20);
    expect(clampApifyMaxItems(broadened, 25)).toBe(20);
  });

  it("platform configs expose hardening fields", () => {
    for (const cfg of [INSTAGRAM_APIFY_CONFIG, LINKEDIN_APIFY_CONFIG]) {
      expect(cfg.purpose).toBeTruthy();
      expect(cfg.actorId).toBeTruthy();
      expect(cfg.build).toBeTruthy();
      expect(typeof cfg.enabled).toBe("boolean");
      expect(cfg.pricingModel).toBeTruthy();
      expect(cfg.estimatedUnitCost).toBeGreaterThan(0);
      expect(cfg.pricingSnapshotAt).toBeTruthy();
      expect(cfg.risk).toBeTruthy();
      expect(["NONE", "DATACENTER", "RESIDENTIAL_REQUIRED", "SERP"]).toContain(cfg.proxyPolicy);
      expect(cfg.defaultMaxItems).toBeGreaterThan(0);
      expect(cfg.hardMaxItems).toBeGreaterThanOrEqual(cfg.defaultMaxItems);
      expect(cfg.timeout).toBeGreaterThan(0);
      expect(cfg.lastReviewedAt).toBeTruthy();
    }
  });
});
