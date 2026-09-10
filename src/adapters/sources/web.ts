import {
  SourceNotConfiguredError,
  SourceRateLimitError,
  SourceUnavailableError,
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
import { logger } from "@/lib/logger";

/**
 * General web search via Tavily (default) or Exa — selected by WEB_SEARCH_PROVIDER.
 * On genuine primary availability/quota failures, falls back to the other supported
 * provider when its API key is configured. Never falls back for ordinary empty results.
 * Customer-facing errors stay provider-agnostic.
 */

type WebProvider = "tavily" | "exa";

function acquire(organisationId: string): void {
  const ok = tryAcquireRateLimit({
    key: `web:${organisationId}`,
    limit: Number(getEnv().WEB_SEARCH_RATE_LIMIT_PER_MIN || 40),
    windowMs: 60_000,
  });
  if (!ok) throw new SourceRateLimitError("web");
}

/** True when the failure is quota / auth / hard unavailability — not empty results. */
export function isWebProviderAvailabilityFailure(error: unknown): boolean {
  if (error instanceof SourceRateLimitError) return true;
  if (error instanceof SourceUnavailableError) return true;
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  // Match status / quota signals without requiring a specific vendor string in the check.
  if (/\b(401|402|403|429|432|500|502|503|504)\b/.test(msg)) return true;
  if (/usage limit|quota|rate limit|plan'?s set usage|insufficient credits|payment required/i.test(msg)) {
    return true;
  }
  if (/failed \(\d{3}\)|econnreset|etimedout|fetch failed|network/i.test(msg)) return true;
  return false;
}

function toCustomerSafeWebError(error: unknown): Error {
  if (error instanceof SourceNotConfiguredError) return error;
  if (error instanceof SourceRateLimitError) {
    return new SourceRateLimitError(
      "web",
      "Web research is temporarily rate limited. Try again shortly.",
    );
  }
  if (error instanceof SourceUnavailableError) {
    return new SourceUnavailableError(
      "web",
      error.message && !/tavily|exa|apify|432|quota/i.test(error.message)
        ? error.message
        : "Web research results were unavailable for this search.",
    );
  }
  if (error instanceof Error && isWebProviderAvailabilityFailure(error)) {
    if (/\b429\b|rate limit/i.test(error.message)) {
      return new SourceRateLimitError(
        "web",
        "Web research is temporarily rate limited. Try again shortly.",
      );
    }
    return new SourceUnavailableError(
      "web",
      "Web research results were unavailable for this search.",
    );
  }
  return new SourceUnavailableError(
    "web",
    "Web research results were unavailable for this search.",
  );
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
    search_depth: "basic",
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
    // Keep status in the thrown Error for internal availability classification;
    // customer mapping strips vendor names via toCustomerSafeWebError.
    throw new Error(`Web search primary failed (${res.status}): ${text.slice(0, 200)}`);
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
    throw new Error(`Web search secondary failed (${res.status}): ${text.slice(0, 200)}`);
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

function resolvePrimaryProvider(env: ReturnType<typeof getEnv>): WebProvider {
  const configured = (env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase();
  if (configured === "exa") return "exa";
  return "tavily";
}

function providerOrder(primary: WebProvider): WebProvider[] {
  return primary === "exa" ? ["exa", "tavily"] : ["tavily", "exa"];
}

function keyFor(provider: WebProvider, env: ReturnType<typeof getEnv>): string | undefined {
  return provider === "exa" ? env.EXA_API_KEY : env.TAVILY_API_KEY;
}

async function runProvider(
  provider: WebProvider,
  query: string,
  options: SourceSearchOptions,
  apiKey: string,
  limit: number,
): Promise<SourceResult[]> {
  return provider === "exa"
    ? searchExa(query, options, apiKey, limit)
    : searchTavily(query, options, apiKey, limit);
}

/** Exported for unit tests — primary then availability fallback. */
export async function searchWebWithFallback(
  query: string,
  options: SourceSearchOptions,
): Promise<SourceResult[]> {
  const env = getEnv();
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
  const primary = resolvePrimaryProvider(env);
  const order = providerOrder(primary).filter((p) => Boolean(keyFor(p, env)));

  if (!order.length) {
    throw new SourceNotConfiguredError(
      "web",
      "Web research is not configured for this workspace.",
    );
  }

  let lastError: unknown = null;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i]!;
    const apiKey = keyFor(provider, env);
    if (!apiKey) continue;
    try {
      const results = await runProvider(provider, query, options, apiKey, limit);
      if (i > 0) {
        logger.warn("Web search used supported fallback after primary availability failure", {
          organisationId: options.organisationId,
          fallbackIndex: i,
        });
      }
      return results;
    } catch (error) {
      lastError = error;
      const canFallback =
        i < order.length - 1 && isWebProviderAvailabilityFailure(error);
      logger.warn("Web search provider attempt failed", {
        organisationId: options.organisationId,
        attempt: i,
        availabilityFailure: isWebProviderAvailabilityFailure(error),
        willFallback: canFallback,
        // Never log raw vendor body / keys.
        statusHint: error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 120) : "unknown",
      });
      if (!canFallback) break;
    }
  }

  throw toCustomerSafeWebError(lastError);
}

export const webSourceAdapter: SourceAdapter = {
  platform: "web",
  displayName: "Web",

  async search(query, options: SourceSearchOptions): Promise<SourceResult[]> {
    const env = getEnv();
    const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
    const primary = resolvePrimaryProvider(env);
    // Cache key ignores which fallback served — same org/query/options.
    const cacheKey = hashSourceQuery({
      platform: "web",
      query,
      organisationId: options.organisationId,
      options: {
        limit,
        provider: primary,
        recent: options.recent ?? true,
        nicheHint: options.nicheHint,
        includeDomains: options.includeDomains?.slice().sort().join(",") ?? "",
      },
    });
    const cached = getCachedSourceResults(cacheKey);
    if (cached) return cached.slice(0, limit);

    const results = await searchWebWithFallback(query, options);
    setCachedSourceResults(cacheKey, results);
    return results;
  },
};
