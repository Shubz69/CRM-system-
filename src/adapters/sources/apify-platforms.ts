import {
  SourceNotConfiguredError,
  SourceRateLimitError,
  SourceUnavailableError,
  type SourceAdapter,
  type SourceEngagement,
  type SourcePlatform,
  type SourceResult,
  type SourceSearchOptions,
} from "@/adapters/sources/types";
import {
  getCachedSourceResults,
  hashSourceQuery,
  setCachedSourceResults,
} from "@/adapters/sources/cache";
import { tryAcquireRateLimit } from "@/adapters/sources/rate-limit";
import {
  ApifyRunFailedError,
  ApifyTimeoutError,
  runApifyActor,
} from "@/adapters/sources/apify-client";
import { addBillableCents, recordApifySpend } from "@/adapters/sources/apify-billing";
import {
  ApifyDeniedError,
  assertApifyKillSwitchAllows,
  assertProxyPolicy,
  buildApifyProvenanceMetadata,
  clampApifyMaxItems,
  estimateMaxTotalChargeUsd,
  findFreshPersistentApifyCache,
  hashApifyCanonicalQuery,
  hashApifyInput,
  resolveApifyProgressiveLimit,
  type ApifyPricingModel,
  type ApifyProxyPolicy,
  type ApifyRiskLevel,
} from "@/adapters/sources/apify-hardening";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";

export type ApifyPlatformConfig = {
  platform: SourcePlatform;
  displayName: string;
  /** Why this Actor is approved for Agent Desk. */
  purpose: string;
  /** Pinned Actor ID — only allowlisted IDs may run. */
  actorId: string;
  /**
   * @deprecated Alias of actorId for older call sites / tests.
   * Prefer actorId.
   */
  defaultActorId: string;
  /** Build / version pin passed to Apify API (e.g. "latest" or a build number). */
  build: string;
  /** When false, adapter denies all runs for this platform. */
  enabled: boolean;
  pricingModel: ApifyPricingModel;
  /** USD per 1k results (or unit) at pricingSnapshotAt — estimate only. */
  estimatedUnitCost: number;
  pricingSnapshotAt: string;
  risk: ApifyRiskLevel;
  proxyPolicy: ApifyProxyPolicy;
  defaultMaxItems: number;
  hardMaxItems: number;
  /** Per-run wall timeout (ms). */
  timeout: number;
  lastReviewedAt: string;
  /** Optional memory pin (MB). */
  memoryMb?: number;
  /** Env override for actor id, e.g. APIFY_INSTAGRAM_ACTOR_ID — allowlisted only. */
  actorIdEnv: keyof ReturnType<typeof getEnv>;
  /** Env override for timeout ms */
  timeoutEnv: keyof ReturnType<typeof getEnv>;
  /**
   * @deprecated Prefer timeout / estimatedUnitCost.
   * Kept so older helpers keep compiling.
   */
  defaultTimeoutMs: number;
  /** @deprecated Prefer estimatedUnitCost. */
  defaultUsdPer1k: number;
  buildInput: (query: string, options: SourceSearchOptions, limit: number) => Record<string, unknown>;
  mapItem: (item: Record<string, unknown>) => SourceResult | null;
};

/** Approved Actor IDs only — unknown Store Actor IDs are denied. */
const APPROVED_ACTOR_IDS = new Set<string>();

export function registerApprovedApifyActor(actorId: string): void {
  const id = actorId.trim();
  if (id) APPROVED_ACTOR_IDS.add(id);
}

export function listApprovedApifyActors(): string[] {
  return [...APPROVED_ACTOR_IDS].sort();
}

export function isApprovedApifyActor(actorId: string): boolean {
  return APPROVED_ACTOR_IDS.has(actorId.trim());
}

/** Deny arbitrary Actor IDs from user/agent/env input. */
export function assertApprovedApifyActor(
  platform: SourcePlatform,
  actorId: string,
): void {
  if (!isApprovedApifyActor(actorId)) {
    throw new ApifyDeniedError(
      platform,
      "UNKNOWN_ACTOR",
      `${platform} source rejected an unapproved actor.`,
    );
  }
}

function requireApifyToken(platform: SourcePlatform, displayName: string): string {
  const token = getEnv().APIFY_TOKEN;
  if (!token) {
    throw new SourceNotConfiguredError(
      platform,
      `${displayName} is not configured. Set APIFY_TOKEN to enable this licensed data source.`,
    );
  }
  return token;
}

/**
 * Resolve Actor ID from pinned config. Env override is accepted ONLY when the
 * override is itself on the allowlist — never arbitrary Store Actor IDs.
 */
export function resolveActorId(config: ApifyPlatformConfig): string {
  const pinned = (config.actorId || config.defaultActorId).trim();
  const override = getEnv()[config.actorIdEnv];
  if (typeof override === "string" && override.trim()) {
    const candidate = override.trim();
    if (!isApprovedApifyActor(candidate)) {
      throw new ApifyDeniedError(
        config.platform,
        "UNKNOWN_ACTOR",
        `${config.platform} source rejected an unapproved actor override.`,
      );
    }
    return candidate;
  }
  return pinned;
}

function resolveTimeoutMs(config: ApifyPlatformConfig): number {
  const global = Number(getEnv().APIFY_TIMEOUT_MS || 0);
  const perPlatform = Number(getEnv()[config.timeoutEnv] || 0);
  const pinned = config.timeout || config.defaultTimeoutMs;
  const picked =
    (Number.isFinite(perPlatform) && perPlatform > 0 ? perPlatform : 0) ||
    (Number.isFinite(global) && global > 0 ? global : 0) ||
    pinned;
  // Cap so a single actor cannot consume the default 10-minute supervisor budget alone.
  return Math.min(Math.max(5_000, Math.floor(picked)), 180_000);
}

function resolveUsdPer1k(config: ApifyPlatformConfig): number {
  const override = Number(getEnv().APIFY_USD_PER_1K_RESULTS || 0);
  if (Number.isFinite(override) && override > 0) return override;
  return config.estimatedUnitCost || config.defaultUsdPer1k;
}

function estimateCostCents(input: {
  config: ApifyPlatformConfig;
  limit: number;
  usageTotalUsd: number | null;
  itemCount: number;
}): number {
  // Completed-run usage is authoritative when Apify reports it.
  if (input.usageTotalUsd != null && Number.isFinite(input.usageTotalUsd) && input.usageTotalUsd > 0) {
    return Math.max(1, Math.round(input.usageTotalUsd * 100));
  }
  const per1k = resolveUsdPer1k(input.config);
  const units = Math.max(input.itemCount, Math.min(input.limit, 1));
  return Math.max(1, Math.ceil((units * per1k * 100) / 1000));
}

function acquire(platform: SourcePlatform, organisationId: string): void {
  const limit = Number(getEnv().APIFY_RATE_LIMIT_PER_MIN || 10);
  const ok = tryAcquireRateLimit({
    key: `apify:${platform}:${organisationId}`,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
    windowMs: 60_000,
  });
  if (!ok) throw new SourceRateLimitError(platform);
}

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === "number" && Number.isFinite(v)) {
    // TikTok often uses unix seconds.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function slugHashtag(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 64);
}

export function createApifySourceAdapter(config: ApifyPlatformConfig): SourceAdapter {
  registerApprovedApifyActor(config.actorId || config.defaultActorId);

  return {
    platform: config.platform,
    displayName: config.displayName,

    async search(query, options: SourceSearchOptions): Promise<SourceResult[]> {
      requireApifyToken(config.platform, config.displayName);

      if (!config.enabled) {
        throw new ApifyDeniedError(
          config.platform,
          "DISABLED",
          `${config.displayName} source is disabled.`,
        );
      }

      await assertApifyKillSwitchAllows(config.platform, options.organisationId);

      const actorId = resolveActorId(config);
      assertApprovedApifyActor(config.platform, actorId);

      const progressiveLimit = resolveApifyProgressiveLimit({
        defaultMaxItems: config.defaultMaxItems,
        hardMaxItems: config.hardMaxItems,
        requestedLimit: options.limit,
        answerMode: options.answerMode,
        qualityBudget: options.qualityBudget,
        governorMode: options.governorMode,
        broaden: options.broadenApify,
      });
      const limit = clampApifyMaxItems(progressiveLimit, config.hardMaxItems);

      const timeoutMs = resolveTimeoutMs(config);
      const build = config.build;

      const cacheKey = hashSourceQuery({
        platform: config.platform,
        query,
        organisationId: options.organisationId,
        options: {
          limit,
          recent: options.recent ?? true,
          nicheHint: options.nicheHint,
          actorId,
          build,
        },
      });
      const cached = getCachedSourceResults(cacheKey);
      if (cached) return cached.slice(0, limit);

      const canonicalQueryHash = hashApifyCanonicalQuery({
        organisationId: options.organisationId,
        platform: config.platform,
        query,
        actorId,
        limit,
        nicheHint: options.nicheHint,
        recent: options.recent,
      });

      const persistent = await findFreshPersistentApifyCache({
        organisationId: options.organisationId,
        platform: config.platform,
        canonicalQueryHash,
        limit,
      });
      if (persistent?.length) {
        setCachedSourceResults(cacheKey, persistent);
        return persistent.slice(0, limit);
      }

      acquire(config.platform, options.organisationId);

      const estimatedCents = estimateCostCents({
        config,
        limit,
        usageTotalUsd: null,
        itemCount: limit,
      });
      await assertWithinSpendCap(options.organisationId, estimatedCents);

      const actorInput = config.buildInput(query, options, limit);
      assertProxyPolicy(config.platform, config.proxyPolicy, actorInput);

      const inputHash = hashApifyInput(actorInput);
      const maxTotalChargeUsd = estimateMaxTotalChargeUsd({
        estimatedUnitCost: resolveUsdPer1k(config),
        maxItems: limit,
      });
      const started = Date.now();

      try {
        const run = await runApifyActor({
          platform: config.platform,
          actorId,
          actorInput,
          timeoutMs,
          maxItems: limit,
          maxTotalChargeUsd,
          memoryMb: config.memoryMb,
          build,
        });

        const results: SourceResult[] = [];
        for (const item of run.items) {
          const mapped = config.mapItem(item);
          if (!mapped?.url) continue;
          results.push(mapped);
          if (results.length >= limit) break;
        }

        const costCents = estimateCostCents({
          config,
          limit,
          usageTotalUsd: run.usageTotalUsd,
          itemCount: Math.max(results.length, 1),
        });
        addBillableCents(options._billableCents, costCents);

        const retrievedAt = new Date().toISOString();
        const actorBuild = run.build || build;

        await recordApifySpend({
          organisationId: options.organisationId,
          platform: config.platform,
          costCents,
          success: results.length > 0,
          latencyMs: Date.now() - started,
          metadata: {
            actorId,
            actorBuild,
            runId: run.runId,
            inputHash,
            itemCount: results.length,
            usageTotalUsd: run.usageTotalUsd,
            actualCostAuthoritative: run.usageTotalUsd != null,
          },
        });

        if (!results.length) {
          logger.warn(`${config.displayName} Apify run returned no mappable results`, {
            platform: config.platform,
            organisationId: options.organisationId,
            actorId,
            runId: run.runId,
            rawItemCount: run.items.length,
          });
          throw new SourceUnavailableError(
            config.platform,
            `${config.displayName} results were unavailable for this search.`,
          );
        }

        for (const r of results) {
          r.rawMetadata = buildApifyProvenanceMetadata({
            existing: r.rawMetadata,
            provenance: {
              sourcePlatform: config.platform,
              retrievalMechanism: "apify",
              canonicalQueryHash,
              actorId,
              actorBuild,
              runId: run.runId,
              inputHash,
              retrievedAt,
              actualCost: {
                usageTotalUsd: run.usageTotalUsd,
                costCents,
              },
            },
          });
        }

        setCachedSourceResults(cacheKey, results);
        return results;
      } catch (error) {
        const latencyMs = Date.now() - started;
        const message = error instanceof Error ? error.message : "unknown";

        if (error instanceof ApifyDeniedError) {
          throw error;
        }

        // Still gate residual cost when Apify may have started billing.
        if (
          error instanceof ApifyTimeoutError ||
          error instanceof ApifyRunFailedError
        ) {
          const residual = Math.max(1, Math.floor(estimatedCents / 4));
          addBillableCents(options._billableCents, residual);
          await recordApifySpend({
            organisationId: options.organisationId,
            platform: config.platform,
            costCents: residual,
            success: false,
            latencyMs,
            error: message,
            metadata: { actorId, failure: error.name },
          }).catch(() => undefined);
        }

        logger.warn(`${config.displayName} Apify source unavailable`, {
          platform: config.platform,
          organisationId: options.organisationId,
          actorId,
          message,
          code:
            error instanceof ApifyTimeoutError || error instanceof ApifyRunFailedError
              ? error.code
              : error instanceof SourceRateLimitError
                ? error.code
                : "SOURCE_ERROR",
        });

        if (error instanceof SourceNotConfiguredError || error instanceof SourceRateLimitError) {
          throw error;
        }

        throw new SourceUnavailableError(
          config.platform,
          `${config.displayName} results were unavailable for this search.`,
        );
      }
    },
  };
}

const REVIEWED = "2026-08-30";

/** --- Platform configs (approved Actors only — review before production lock-in) --- */

export const INSTAGRAM_APIFY_CONFIG: ApifyPlatformConfig = {
  platform: "instagram",
  displayName: "Instagram",
  purpose: "Hashtag / explore post retrieval for research & social listening",
  actorId: "apify/instagram-scraper",
  defaultActorId: "apify/instagram-scraper",
  build: "latest",
  enabled: true,
  pricingModel: "PPE",
  estimatedUnitCost: 2.7,
  pricingSnapshotAt: REVIEWED,
  risk: "medium",
  proxyPolicy: "DATACENTER",
  defaultMaxItems: 8,
  hardMaxItems: 25,
  timeout: 75_000,
  lastReviewedAt: REVIEWED,
  memoryMb: 4096,
  actorIdEnv: "APIFY_INSTAGRAM_ACTOR_ID",
  timeoutEnv: "APIFY_INSTAGRAM_TIMEOUT_MS",
  defaultTimeoutMs: 75_000,
  defaultUsdPer1k: 2.7,
  buildInput(query, options, limit) {
    const tag = slugHashtag(options.nicheHint ? `${query} ${options.nicheHint}` : query);
    const hashtag = tag || "explore";
    return {
      directUrls: [`https://www.instagram.com/explore/tags/${hashtag}/`],
      resultsType: "posts",
      resultsLimit: limit,
      searchLimit: limit,
      ...(options.recent === false ? {} : { onlyPostsNewerThan: "60 days" }),
    };
  },
  mapItem(item) {
    const url =
      asString(item.url) ||
      asString(item.inputUrl) ||
      (asString(item.shortCode)
        ? `https://www.instagram.com/p/${asString(item.shortCode)}/`
        : null);
    if (!url) return null;
    const caption = asString(item.caption) || asString(item.text) || "";
    const owner: string | null =
      asString(item.ownerUsername) ||
      (item.owner && typeof item.owner === "object"
        ? asString((item.owner as Record<string, unknown>).username)
        : null) ||
      asString(item.ownerFullName);
    const likes = asNumber(item.likesCount) ?? asNumber(item.likes);
    const comments = asNumber(item.commentsCount) ?? asNumber(item.comments);
    const views =
      asNumber(item.videoViewCount) ?? asNumber(item.videoPlayCount) ?? asNumber(item.viewsCount);
    const engagement: SourceEngagement = {
      likes,
      comments,
      views,
      score: (views ?? 0) + (likes ?? 0) * 10 + (comments ?? 0) * 20,
      raw: {
        likesCount: likes,
        commentsCount: comments,
        viewsCount: views,
      },
    };
    const shortCode = asString(item.shortCode);
    const type = asString(item.type) || asString(item.productType);
    return {
      url,
      title: caption.slice(0, 120) || `Instagram post by ${owner || "unknown"}`,
      content: caption.slice(0, 8000),
      author: owner,
      publishedAt: asDate(item.timestamp) || asDate(item.takenAt) || asDate(item.publishedAt),
      platform: "instagram" as const,
      engagement,
      rawMetadata: {
        shortCode,
        type,
      },
    };
  },
};

export const TIKTOK_APIFY_CONFIG: ApifyPlatformConfig = {
  platform: "tiktok",
  displayName: "TikTok",
  purpose: "Keyword / hashtag video search for research & social listening",
  actorId: "clockworks/tiktok-scraper",
  defaultActorId: "clockworks/tiktok-scraper",
  build: "latest",
  enabled: true,
  pricingModel: "PPE",
  estimatedUnitCost: 1.7,
  pricingSnapshotAt: REVIEWED,
  risk: "medium",
  proxyPolicy: "DATACENTER",
  defaultMaxItems: 8,
  hardMaxItems: 25,
  timeout: 75_000,
  lastReviewedAt: REVIEWED,
  memoryMb: 4096,
  actorIdEnv: "APIFY_TIKTOK_ACTOR_ID",
  timeoutEnv: "APIFY_TIKTOK_TIMEOUT_MS",
  defaultTimeoutMs: 75_000,
  defaultUsdPer1k: 1.7,
  buildInput(query, options, limit) {
    const q = options.nicheHint ? `${query} ${options.nicheHint}` : query;
    return {
      searchQueries: [q.trim()],
      resultsPerPage: limit,
      maxItems: limit,
      searchSection: "/video",
      ...(options.recent === false ? {} : { videoSearchDateFilter: "LAST_MONTH" }),
    };
  },
  mapItem(item) {
    const url =
      asString(item.webVideoUrl) ||
      asString(item.url) ||
      asString(item.submittedVideoUrl) ||
      (asString(item.id) ? `https://www.tiktok.com/@/video/${asString(item.id)}` : null);
    if (!url) return null;
    const authorMeta =
      item.authorMeta && typeof item.authorMeta === "object"
        ? (item.authorMeta as Record<string, unknown>)
        : null;
    const author: string | null =
      asString(item.author) ||
      (authorMeta ? asString(authorMeta.name) || asString(authorMeta.nickName) : null) ||
      asString(item.nickname);
    const text = asString(item.text) || asString(item.desc) || asString(item.title) || "";
    const likes = asNumber(item.diggCount) ?? asNumber(item.likes);
    const comments = asNumber(item.commentCount) ?? asNumber(item.comments);
    const shares = asNumber(item.shareCount) ?? asNumber(item.shares);
    const views = asNumber(item.playCount) ?? asNumber(item.views);
    return {
      url,
      title: text.slice(0, 120) || `TikTok by ${author || "unknown"}`,
      content: text.slice(0, 8000),
      author,
      publishedAt: asDate(item.createTime) || asDate(item.createTimeISO) || asDate(item.publishedAt),
      platform: "tiktok",
      engagement: {
        likes,
        comments,
        shares,
        views,
        score: (views ?? 0) + (likes ?? 0) * 10 + (comments ?? 0) * 20 + (shares ?? 0) * 15,
        raw: { diggCount: likes, commentCount: comments, shareCount: shares, playCount: views },
      },
      rawMetadata: {
        id: item.id ?? null,
        hashtags: item.hashtags ?? null,
      },
    };
  },
};

export const TWITTER_APIFY_CONFIG: ApifyPlatformConfig = {
  platform: "twitter",
  displayName: "Twitter/X",
  purpose: "Keyword tweet search for research & social listening",
  actorId: "apidojo/tweet-scraper",
  defaultActorId: "apidojo/tweet-scraper",
  build: "latest",
  enabled: true,
  pricingModel: "PPE",
  estimatedUnitCost: 1.0,
  pricingSnapshotAt: REVIEWED,
  risk: "medium",
  proxyPolicy: "DATACENTER",
  defaultMaxItems: 8,
  hardMaxItems: 25,
  timeout: 60_000,
  lastReviewedAt: REVIEWED,
  memoryMb: 2048,
  actorIdEnv: "APIFY_TWITTER_ACTOR_ID",
  timeoutEnv: "APIFY_TWITTER_TIMEOUT_MS",
  defaultTimeoutMs: 60_000,
  defaultUsdPer1k: 1.0,
  buildInput(query, options, limit) {
    const q = options.nicheHint ? `${query} ${options.nicheHint}` : query;
    return {
      searchTerms: [q.trim()],
      maxItems: limit,
      sort: options.recent === false ? "Top" : "Latest",
    };
  },
  mapItem(item) {
    const url = asString(item.url) || asString(item.twitterUrl);
    if (!url) return null;
    const authorObj =
      item.author && typeof item.author === "object" ? (item.author as Record<string, unknown>) : null;
    const author: string | null =
      (authorObj ? asString(authorObj.userName) || asString(authorObj.name) : null) ||
      asString(item.userName);
    const text = asString(item.text) || asString(item.fullText) || "";
    const likes = asNumber(item.likeCount);
    const comments = asNumber(item.replyCount);
    const shares = asNumber(item.retweetCount);
    const views = asNumber(item.viewCount);
    return {
      url,
      title: text.slice(0, 120) || `Tweet by ${author || "unknown"}`,
      content: text.slice(0, 8000),
      author,
      publishedAt: asDate(item.createdAt),
      platform: "twitter" as const,
      engagement: {
        likes,
        comments,
        shares,
        views,
        score: (views ?? 0) + (likes ?? 0) * 10 + (comments ?? 0) * 20 + (shares ?? 0) * 15,
        raw: { likeCount: likes, replyCount: comments, retweetCount: shares, viewCount: views },
      },
      rawMetadata: {
        id: item.id ?? null,
      },
    };
  },
};

export const THREADS_APIFY_CONFIG: ApifyPlatformConfig = {
  platform: "threads",
  displayName: "Threads",
  purpose: "Keyword Threads post search for research & social listening",
  actorId: "automation-lab/threads-scraper",
  defaultActorId: "automation-lab/threads-scraper",
  build: "latest",
  enabled: true,
  pricingModel: "PPE",
  estimatedUnitCost: 1.5,
  pricingSnapshotAt: REVIEWED,
  risk: "high",
  proxyPolicy: "DATACENTER",
  defaultMaxItems: 8,
  hardMaxItems: 25,
  timeout: 60_000,
  lastReviewedAt: REVIEWED,
  memoryMb: 2048,
  actorIdEnv: "APIFY_THREADS_ACTOR_ID",
  timeoutEnv: "APIFY_THREADS_TIMEOUT_MS",
  defaultTimeoutMs: 60_000,
  defaultUsdPer1k: 1.5,
  buildInput(query, options, limit) {
    const q = options.nicheHint ? `${query} ${options.nicheHint}` : query;
    return {
      mode: "search",
      searchQueries: [q.trim()],
      maxPosts: limit,
    };
  },
  mapItem(item) {
    const url = asString(item.url) || asString(item.postUrl);
    if (!url) return null;
    const author: string | null = asString(item.username) || asString(item.authorUsername);
    const text = asString(item.text) || asString(item.caption) || "";
    const likes = asNumber(item.likeCount) ?? asNumber(item.likes);
    const comments = asNumber(item.replyCount) ?? asNumber(item.comments);
    const shares = asNumber(item.repostCount) ?? asNumber(item.reposts);
    return {
      url,
      title: text.slice(0, 120) || `Threads post by ${author || "unknown"}`,
      content: text.slice(0, 8000),
      author,
      publishedAt: asDate(item.timestamp) || asDate(item.createdAt) || asDate(item.publishedAt),
      platform: "threads" as const,
      engagement: {
        likes,
        comments,
        shares,
        score: (likes ?? 0) * 10 + (comments ?? 0) * 20 + (shares ?? 0) * 15,
        raw: { likeCount: likes, replyCount: comments, repostCount: shares },
      },
      rawMetadata: {
        id: item.id ?? null,
        hashtags: item.hashtags ?? null,
      },
    };
  },
};

export const LINKEDIN_APIFY_CONFIG: ApifyPlatformConfig = {
  platform: "linkedin",
  displayName: "LinkedIn",
  purpose: "Keyword LinkedIn post search — no cookie rental",
  actorId: "harvestapi/linkedin-post-search",
  defaultActorId: "harvestapi/linkedin-post-search",
  build: "latest",
  enabled: true,
  pricingModel: "PPE",
  estimatedUnitCost: 2.0,
  pricingSnapshotAt: REVIEWED,
  risk: "high",
  proxyPolicy: "DATACENTER",
  defaultMaxItems: 6,
  hardMaxItems: 15,
  timeout: 55_000,
  lastReviewedAt: REVIEWED,
  memoryMb: 4096,
  actorIdEnv: "APIFY_LINKEDIN_ACTOR_ID",
  timeoutEnv: "APIFY_LINKEDIN_TIMEOUT_MS",
  defaultTimeoutMs: 55_000,
  defaultUsdPer1k: 2.0,
  buildInput(query, options, limit) {
    const q = options.nicheHint ? `${query} ${options.nicheHint}` : query;
    return {
      searchQueries: [q.trim()],
      maxPosts: limit,
      sortBy: options.recent === false ? "relevance" : "date",
      ...(options.recent === false ? {} : { postedLimit: "month" }),
      profileScraperMode: "short",
      scrapeReactions: false,
      scrapeComments: false,
    };
  },
  mapItem(item) {
    const url =
      asString(item.url) ||
      asString(item.postUrl) ||
      asString(item.linkedinUrl) ||
      asString(item.link);
    if (!url) return null;
    const authorObj =
      item.author && typeof item.author === "object"
        ? (item.author as Record<string, unknown>)
        : null;
    const author: string | null =
      asString(item.authorName) ||
      (authorObj ? asString(authorObj.name) || asString(authorObj.publicIdentifier) : null) ||
      (typeof item.author === "string" ? asString(item.author) : null);
    const content =
      asString(item.content) ||
      asString(item.text) ||
      asString(item.commentary) ||
      asString(item.postContent) ||
      "";
    const likes =
      asNumber(item.likesCount) ??
      asNumber(item.numLikes) ??
      asNumber(item.reactionCount) ??
      asNumber(item.likes);
    const comments =
      asNumber(item.commentsCount) ?? asNumber(item.numComments) ?? asNumber(item.comments);
    const shares = asNumber(item.sharesCount) ?? asNumber(item.repostsCount);
    return {
      url,
      title: content.slice(0, 120) || `LinkedIn post by ${author || "unknown"}`,
      content: content.slice(0, 8000),
      author,
      publishedAt:
        asDate(item.postedAt) ||
        asDate(item.publishedAt) ||
        asDate(item.postedDate) ||
        asDate(item.timestamp),
      platform: "linkedin",
      engagement: {
        likes,
        comments,
        shares,
        score: (likes ?? 0) * 10 + (comments ?? 0) * 20 + (shares ?? 0) * 15,
        raw: { likesCount: likes, commentsCount: comments, sharesCount: shares },
      },
      rawMetadata: {
        urn: item.urn ?? item.postId ?? null,
      },
    };
  },
};

// Register approved actors at module load (adapters also register on create).
for (const cfg of [
  INSTAGRAM_APIFY_CONFIG,
  TIKTOK_APIFY_CONFIG,
  TWITTER_APIFY_CONFIG,
  THREADS_APIFY_CONFIG,
  LINKEDIN_APIFY_CONFIG,
]) {
  registerApprovedApifyActor(cfg.actorId);
}
