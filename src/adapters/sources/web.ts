import {
  SourceNotConfiguredError,
  SourceRateLimitError,
  type SourceAdapter,
  type SourceResult,
  type SourceSearchOptions,
} from "@/adapters/sources/types";
import { tryAcquireRateLimit } from "@/adapters/sources/rate-limit";
import {
  getCachedSourceResults,
  hashSourceQuery,
  setCachedSourceResults,
} from "@/adapters/sources/cache";
import { getEnv } from "@/lib/env";

/**
 * General web search via Tavily (default) or Exa — selected by WEB_SEARCH_PROVIDER.
 * Blogs, forums, docs, and general web pages.
 */
function acquire(organisationId: string): void {
  const ok = tryAcquireRateLimit({
    key: `web:${organisationId}`,
    limit: Number(getEnv().WEB_SEARCH_RATE_LIMIT_PER_MIN || 40),
    windowMs: 60_000,
  });
  if (!ok) throw new SourceRateLimitError("web");
}

async function searchTavily(
  query: string,
  options: SourceSearchOptions,
  apiKey: string,
  limit: number,
): Promise<SourceResult[]> {
  acquire(options.organisationId);
  const body: Record<string, unknown> = {
    api_key: apiKey,
    query: options.nicheHint ? `${query} ${options.nicheHint}` : query,
    max_results: limit,
    include_answer: false,
    search_depth: "advanced",
  };
  if (options.includeDomains?.length) {
    body.include_domains = options.includeDomains;
  }
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily search failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    results?: Array<{
      url?: string;
      title?: string;
      content?: string;
      published_date?: string;
      score?: number;
    }>;
  };
  return (json.results || [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url!,
      title: r.title || r.url!,
      content: (r.content || "").slice(0, 8000),
      author: null,
      publishedAt: r.published_date ? new Date(r.published_date) : null,
      platform: "web" as const,
      engagement: r.score != null ? { score: r.score } : null,
      rawMetadata: {
        provider: "tavily",
        score: r.score,
        includeDomains: options.includeDomains ?? null,
      },
    }));
}

async function searchExa(
  query: string,
  options: SourceSearchOptions,
  apiKey: string,
  limit: number,
): Promise<SourceResult[]> {
  acquire(options.organisationId);
  const body: Record<string, unknown> = {
    query: options.nicheHint ? `${query} ${options.nicheHint}` : query,
    numResults: limit,
    type: options.recent === false ? "auto" : "auto",
    contents: { text: { maxCharacters: 4000 } },
    useAutoprompt: true,
  };
  if (options.includeDomains?.length) {
    body.includeDomains = options.includeDomains;
  }
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exa search failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    results?: Array<{
      url?: string;
      title?: string;
      text?: string;
      author?: string;
      publishedDate?: string;
      score?: number;
    }>;
  };
  return (json.results || [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url!,
      title: r.title || r.url!,
      content: (r.text || "").slice(0, 8000),
      author: r.author || null,
      publishedAt: r.publishedDate ? new Date(r.publishedDate) : null,
      platform: "web" as const,
      engagement: r.score != null ? { score: r.score } : null,
      rawMetadata: {
        provider: "exa",
        score: r.score,
        includeDomains: options.includeDomains ?? null,
      },
    }));
}

export const webSourceAdapter: SourceAdapter = {
  platform: "web",
  displayName: "Web",

  async search(query, options: SourceSearchOptions): Promise<SourceResult[]> {
    const env = getEnv();
    const provider = (env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase();
    const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
    const cacheKey = hashSourceQuery({
      platform: "web",
      query,
      organisationId: options.organisationId,
      options: {
        limit,
        provider,
        recent: options.recent ?? true,
        nicheHint: options.nicheHint,
        includeDomains: options.includeDomains?.slice().sort().join(",") ?? "",
      },
    });
    const cached = getCachedSourceResults(cacheKey);
    if (cached) return cached.slice(0, limit);

    let results: SourceResult[];
    if (provider === "exa") {
      if (!env.EXA_API_KEY) {
        throw new SourceNotConfiguredError(
          "web",
          "WEB_SEARCH_PROVIDER=exa but EXA_API_KEY is not configured",
        );
      }
      results = await searchExa(query, options, env.EXA_API_KEY, limit);
    } else if (provider === "tavily") {
      if (!env.TAVILY_API_KEY) {
        throw new SourceNotConfiguredError(
          "web",
          "WEB_SEARCH_PROVIDER=tavily but TAVILY_API_KEY is not configured",
        );
      }
      results = await searchTavily(query, options, env.TAVILY_API_KEY, limit);
    } else {
      throw new SourceNotConfiguredError(
        "web",
        `Unknown WEB_SEARCH_PROVIDER="${provider}". Supported: tavily, exa`,
      );
    }

    setCachedSourceResults(cacheKey, results);
    return results;
  },
};
