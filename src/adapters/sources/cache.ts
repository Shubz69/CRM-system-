import { createHash } from "crypto";
import type { SourcePlatform, SourceResult } from "@/adapters/sources/types";
import { getEnv } from "@/lib/env";

type CacheEntry = {
  expiresAt: number;
  results: SourceResult[];
};

const cache = new Map<string, CacheEntry>();

export function getSourceCacheTtlMs(): number {
  const seconds = Number(getEnv().RESEARCH_CACHE_TTL_SECONDS || 6 * 60 * 60);
  if (!Number.isFinite(seconds) || seconds < 60) return 6 * 60 * 60 * 1000;
  return Math.floor(seconds * 1000);
}

export function hashSourceQuery(input: {
  platform: SourcePlatform;
  query: string;
  organisationId: string;
  options?: Record<string, unknown>;
}): string {
  const payload = JSON.stringify({
    platform: input.platform,
    query: input.query.trim().toLowerCase(),
    organisationId: input.organisationId,
    options: input.options ?? {},
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function getCachedSourceResults(key: string): SourceResult[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Return deep-enough copy so callers cannot mutate cache.
  return entry.results.map((r) => ({
    ...r,
    publishedAt: r.publishedAt ? new Date(r.publishedAt) : null,
    engagement: r.engagement ? { ...r.engagement } : null,
    rawMetadata: { ...r.rawMetadata },
  }));
}

export function setCachedSourceResults(key: string, results: SourceResult[], ttlMs?: number): void {
  cache.set(key, {
    expiresAt: Date.now() + (ttlMs ?? getSourceCacheTtlMs()),
    results: results.map((r) => ({
      ...r,
      publishedAt: r.publishedAt ? new Date(r.publishedAt) : null,
      engagement: r.engagement ? { ...r.engagement } : null,
      rawMetadata: { ...r.rawMetadata },
    })),
  });
}

/** Test helper */
export function clearSourceCache(): void {
  cache.clear();
}
