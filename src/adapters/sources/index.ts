import { redditSourceAdapter } from "@/adapters/sources/reddit";
import { hasWebSearchCredentials, webSourceAdapter } from "@/adapters/sources/web";
import { youtubeSourceAdapter } from "@/adapters/sources/youtube";
import {
  instagramSourceAdapter,
  linkedInSourceAdapter,
  threadsSourceAdapter,
  tiktokSourceAdapter,
  twitterSourceAdapter,
} from "@/adapters/sources/stubs";
import {
  SourceAuthRequiredError,
  SourceNotConfiguredError,
  SourceUnavailableError,
  type SourceAdapter,
  type SourcePlatform,
  type SourceResult,
  type SourceSearchOptions,
} from "@/adapters/sources/types";
import { ApifyDeniedError } from "@/adapters/sources/apify-hardening";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export type {
  SourceAdapter,
  SourceEngagement,
  SourcePlatform,
  SourceResult,
  SourceSearchOptions,
} from "@/adapters/sources/types";
export {
  SourceAuthRequiredError,
  SourceNotConfiguredError,
  SourceRateLimitError,
  SourceUnavailableError,
} from "@/adapters/sources/types";
export {
  ApifyDeniedError,
  isApifyEnabled,
  setApifyGlobalEnabled,
  setApifyOrgEnabled,
} from "@/adapters/sources/apify-hardening";
export {
  collectCheapestSufficientSources,
  SOURCE_COST_TIER_ORDER,
  type SourceCostTier,
} from "@/adapters/sources/source-ordering";
export {
  assertApprovedApifyActor,
  isApprovedApifyActor,
  listApprovedApifyActors,
} from "@/adapters/sources/apify-platforms";

const PLATFORM_DISPLAY: Record<SourcePlatform, string> = {
  youtube: "YouTube",
  reddit: "Reddit",
  web: "Web search",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  twitter: "Twitter/X",
  threads: "Threads",
};

function userFacingSourceError(platform: SourcePlatform, error: unknown): {
  message: string;
  code: string;
} {
  if (error instanceof SourceAuthRequiredError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof SourceNotConfiguredError) {
    return {
      code: platform === "web" ? "AUTH_REQUIRED" : error.code,
      message:
        platform === "web"
          ? error.message
          : `${PLATFORM_DISPLAY[platform]} is not configured for this workspace.`,
    };
  }
  if (error instanceof ApifyDeniedError) {
    return {
      code: error.code,
      message: `${PLATFORM_DISPLAY[platform]} results were unavailable for this search.`,
    };
  }
  if (error instanceof SourceUnavailableError) {
    return {
      code: error.code,
      message: error.message || `${PLATFORM_DISPLAY[platform]} results were unavailable for this search.`,
    };
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "AUTH_REQUIRED") {
      return {
        code,
        message:
          error instanceof Error
            ? error.message
            : `${PLATFORM_DISPLAY[platform]} is not configured for this workspace.`,
      };
    }
    if (code === "SOURCE_RATE_LIMITED") {
      return {
        code,
        message: `${PLATFORM_DISPLAY[platform]} is temporarily rate limited. Try again shortly.`,
      };
    }
  }
  // Never leak actor IDs / provider internals to the brief.
  return {
    code: "SOURCE_UNAVAILABLE",
    message: `${PLATFORM_DISPLAY[platform]} results were unavailable for this search.`,
  };
}

const ALL_ADAPTERS: SourceAdapter[] = [
  youtubeSourceAdapter,
  redditSourceAdapter,
  webSourceAdapter,
  instagramSourceAdapter,
  linkedInSourceAdapter,
  tiktokSourceAdapter,
  twitterSourceAdapter,
  threadsSourceAdapter,
];

export function getSourceAdapter(platform: SourcePlatform): SourceAdapter {
  const found = ALL_ADAPTERS.find((a) => a.platform === platform);
  if (!found) {
    throw new SourceNotConfiguredError(platform, `Unknown source platform: ${platform}`);
  }
  return found;
}

export function listSourceAdapters(): SourceAdapter[] {
  return [...ALL_ADAPTERS];
}

/** Platforms that have credentials present. Apify-backed sources need APIFY_TOKEN. */
export function listConfiguredSourcePlatforms(): SourcePlatform[] {
  const env = getEnv();
  const configured: SourcePlatform[] = [];
  if (env.YOUTUBE_API_KEY) configured.push("youtube");
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) configured.push("reddit");
  // Web is available when any supported search key is present (primary or fallback).
  if (hasWebSearchCredentials(env)) configured.push("web");
  if (env.APIFY_TOKEN) {
    configured.push("instagram", "linkedin", "tiktok", "twitter", "threads");
  }
  return configured;
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function raceAdapterSearch(
  promise: Promise<SourceResult[]>,
  timeoutMs: number | undefined,
  platform: SourcePlatform,
): Promise<SourceResult[]> {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<SourceResult[]>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new SourceUnavailableError(
              platform,
              `${platform} search timed out after ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run configured adapters for one query in parallel (capped).
 * Unconfigured adapters are skipped with an explicit log — never fake results.
 */
export async function searchConfiguredSources(input: {
  query: string;
  options: SourceSearchOptions;
  platforms?: SourcePlatform[];
  concurrency?: number;
}): Promise<{
  results: SourceResult[];
  errors: Array<{ platform: SourcePlatform; message: string; code: string }>;
  /** Sum of billable adapter costs for this fan-out (Apify, etc.). */
  billableCents: number;
}> {
  const platforms = input.platforms?.length
    ? input.platforms
    : listConfiguredSourcePlatforms();
  const concurrency = input.concurrency ?? Number(getEnv().RESEARCH_ADAPTER_CONCURRENCY || 3);

  if (!platforms.length) {
    throw new SourceAuthRequiredError(
      "web",
      "No research source adapters are configured (AUTH_REQUIRED). Set TAVILY_API_KEY or EXA_API_KEY on the Vercel web app for Quick Ask (not only Railway). YouTube/Reddit/Apify keys are optional extras.",
    );
  }

  const billable = input.options._billableCents ?? { value: 0 };
  const options: SourceSearchOptions = { ...input.options, _billableCents: billable };
  const timeoutMs = options.timeoutMs;

  const settled = await mapPool(platforms, concurrency, async (platform) => {
    const adapter = getSourceAdapter(platform);
    try {
      const results = await raceAdapterSearch(
        adapter.search(input.query, options),
        timeoutMs,
        platform,
      );
      return { platform, results, error: null as null | { message: string; code: string } };
    } catch (error) {
      const facing = userFacingSourceError(platform, error);
      const rawMessage = error instanceof Error ? error.message : "unknown";
      logger.warn("Source adapter search failed", {
        platform,
        message: rawMessage,
        code: facing.code,
      });
      return { platform, results: [] as SourceResult[], error: facing };
    }
  });

  return {
    results: settled.flatMap((s) => s.results),
    errors: settled
      .filter((s) => s.error)
      .map((s) => ({ platform: s.platform, message: s.error!.message, code: s.error!.code })),
    billableCents: billable.value,
  };
}

/** Deduped plain-English notes for briefs when a platform was skipped. */
export function formatUnavailableSourceNotes(
  errors: Array<{ platform: string; message: string; code?: string }>,
): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const err of errors) {
    // Social not-configured is expected when the topic did not request that network.
    // Web AUTH_REQUIRED / missing TAVILY+EXA must stay visible — Quick Ask is in-process on Vercel.
    if (err.code === "SOURCE_NOT_CONFIGURED" && err.platform !== "web") continue;
    const platform = err.platform as SourcePlatform;
    const label = PLATFORM_DISPLAY[platform] || err.platform;
    const note =
      err.message && !/apify|actor|stack|token/i.test(err.message)
        ? err.message
        : `${label} results were unavailable for this search.`;
    if (seen.has(note)) continue;
    seen.add(note);
    notes.push(note);
  }
  return notes;
}

export function dedupeSourceResults(results: SourceResult[]): SourceResult[] {
  const seen = new Set<string>();
  const out: SourceResult[] = [];
  for (const r of results) {
    const key = r.url.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Prefer higher engagement, then fresher publishedAt. */
export function rankSourceResults(results: SourceResult[]): SourceResult[] {
  return [...results].sort((a, b) => {
    const ae = a.engagement?.score ?? a.engagement?.views ?? a.engagement?.likes ?? 0;
    const be = b.engagement?.score ?? b.engagement?.views ?? b.engagement?.likes ?? 0;
    if (be !== ae) return be - ae;
    const at = a.publishedAt?.getTime() ?? 0;
    const bt = b.publishedAt?.getTime() ?? 0;
    return bt - at;
  });
}
