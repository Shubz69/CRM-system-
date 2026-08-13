import { redditSourceAdapter } from "@/adapters/sources/reddit";
import { webSourceAdapter } from "@/adapters/sources/web";
import { youtubeSourceAdapter } from "@/adapters/sources/youtube";
import {
  instagramSourceAdapter,
  linkedInSourceAdapter,
  tiktokSourceAdapter,
} from "@/adapters/sources/stubs";
import {
  SourceNotConfiguredError,
  type SourceAdapter,
  type SourcePlatform,
  type SourceResult,
  type SourceSearchOptions,
} from "@/adapters/sources/types";
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
  SourceNotConfiguredError,
  SourceRateLimitError,
} from "@/adapters/sources/types";

const ALL_ADAPTERS: SourceAdapter[] = [
  youtubeSourceAdapter,
  redditSourceAdapter,
  webSourceAdapter,
  instagramSourceAdapter,
  linkedInSourceAdapter,
  tiktokSourceAdapter,
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

/** Platforms that have credentials present (stubs never qualify). */
export function listConfiguredSourcePlatforms(): SourcePlatform[] {
  const env = getEnv();
  const configured: SourcePlatform[] = [];
  if (env.YOUTUBE_API_KEY) configured.push("youtube");
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) configured.push("reddit");
  const webProvider = (env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase();
  if (webProvider === "tavily" && env.TAVILY_API_KEY) configured.push("web");
  if (webProvider === "exa" && env.EXA_API_KEY) configured.push("web");
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
}> {
  const platforms = input.platforms?.length
    ? input.platforms
    : listConfiguredSourcePlatforms();
  const concurrency = input.concurrency ?? Number(getEnv().RESEARCH_ADAPTER_CONCURRENCY || 3);

  if (!platforms.length) {
    throw new SourceNotConfiguredError(
      "web",
      "No research source adapters are configured. Set YOUTUBE_API_KEY, REDDIT_CLIENT_ID/SECRET, and/or TAVILY_API_KEY (or EXA_API_KEY).",
    );
  }

  const settled = await mapPool(platforms, concurrency, async (platform) => {
    const adapter = getSourceAdapter(platform);
    try {
      const results = await adapter.search(input.query, input.options);
      return { platform, results, error: null as null | { message: string; code: string } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      const code =
        error instanceof SourceNotConfiguredError
          ? error.code
          : error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "SOURCE_ERROR";
      logger.warn("Source adapter search failed", { platform, message, code });
      return { platform, results: [] as SourceResult[], error: { message, code } };
    }
  });

  return {
    results: settled.flatMap((s) => s.results),
    errors: settled
      .filter((s) => s.error)
      .map((s) => ({ platform: s.platform, message: s.error!.message, code: s.error!.code })),
  };
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
