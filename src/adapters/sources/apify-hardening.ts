/**
 * Essential Apify hardening — allowlist, kill switch, persistent dedupe,
 * provenance, proxy policy, progressive depth. No separate scraping engine.
 */

import { createHash } from "crypto";
import type { SourcePlatform, SourceResult } from "@/adapters/sources/types";
import { getSourceCacheTtlMs } from "@/adapters/sources/cache";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ComputeExecutionMode, VerificationDepth } from "@/services/compute-governor/types";

export type ApifyProxyPolicy = "NONE" | "DATACENTER" | "RESIDENTIAL_REQUIRED" | "SERP";
export type ApifyPricingModel = "PPE" | "RENTAL" | "FREE" | "UNKNOWN";
export type ApifyRiskLevel = "low" | "medium" | "high";
export type AgentAnswerModeLite = "QUICK" | "EXECUTIVE" | "ACTION" | "DEEP";

export type ApifyDenyReason =
  | "UNKNOWN_ACTOR"
  | "DISABLED"
  | "KILL_SWITCH"
  | "PROXY_POLICY"
  | "HARD_CAP";

export class ApifyDeniedError extends Error {
  readonly code = "APIFY_DENIED";
  constructor(
    readonly platform: SourcePlatform,
    readonly reason: ApifyDenyReason,
    message: string,
  ) {
    super(message);
    this.name = "ApifyDeniedError";
  }
}

export const APIFY_GLOBAL_KILL_SWITCH_KEY = "apify.enabled";
export const APIFY_ORG_KILL_SWITCH_KEY = "apify.enabled";

type KillSwitchCache = { enabled: boolean; expiresAt: number };
const killSwitchProcessCache = new Map<string, KillSwitchCache>();
const KILL_SWITCH_CACHE_TTL_MS = 5_000;

/** Test helper — clears process cache only (DB remains authoritative). */
export function clearApifyKillSwitchCache(): void {
  killSwitchProcessCache.clear();
}

function parseEnabledFlag(value: unknown, defaultEnabled: boolean): boolean {
  if (value == null) return defaultEnabled;
  if (typeof value === "boolean") return value;
  if (typeof value === "object" && value !== null && "enabled" in value) {
    const e = (value as { enabled?: unknown }).enabled;
    if (typeof e === "boolean") return e;
  }
  return defaultEnabled;
}

/**
 * Authoritative Apify kill switch. SystemSetting is source of truth for global;
 * OrganisationPreference can disable per-org. Process cache is speed-only.
 * Never calls process.exit.
 */
export async function isApifyEnabled(organisationId?: string): Promise<boolean> {
  const cacheKey = organisationId ? `org:${organisationId}` : "global";
  const cached = killSwitchProcessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.enabled;

  let enabled = true;
  try {
    const global = await prisma.systemSetting.findUnique({
      where: { key: APIFY_GLOBAL_KILL_SWITCH_KEY },
    });
    enabled = parseEnabledFlag(global?.value, true);

    if (enabled && organisationId) {
      const orgPref = await prisma.organisationPreference.findUnique({
        where: {
          organisationId_key: {
            organisationId,
            key: APIFY_ORG_KILL_SWITCH_KEY,
          },
        },
      });
      if (orgPref) {
        enabled = parseEnabledFlag(orgPref.value, true);
      }
    }
  } catch (error) {
    logger.warn("Apify kill-switch read failed — failing closed", {
      organisationId,
      message: error instanceof Error ? error.message : "unknown",
    });
    enabled = false;
  }

  killSwitchProcessCache.set(cacheKey, {
    enabled,
    expiresAt: Date.now() + KILL_SWITCH_CACHE_TTL_MS,
  });
  return enabled;
}

export async function setApifyGlobalEnabled(enabled: boolean): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: APIFY_GLOBAL_KILL_SWITCH_KEY },
    create: { key: APIFY_GLOBAL_KILL_SWITCH_KEY, value: { enabled } },
    update: { value: { enabled } },
  });
  clearApifyKillSwitchCache();
}

export async function setApifyOrgEnabled(
  organisationId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.organisationPreference.upsert({
    where: {
      organisationId_key: { organisationId, key: APIFY_ORG_KILL_SWITCH_KEY },
    },
    create: {
      organisationId,
      key: APIFY_ORG_KILL_SWITCH_KEY,
      value: { enabled },
    },
    update: { value: { enabled } },
  });
  clearApifyKillSwitchCache();
}

export async function assertApifyKillSwitchAllows(
  platform: SourcePlatform,
  organisationId: string,
): Promise<void> {
  const enabled = await isApifyEnabled(organisationId);
  if (!enabled) {
    throw new ApifyDeniedError(
      platform,
      "KILL_SWITCH",
      `${platform} licensed source is temporarily disabled.`,
    );
  }
}

/** Canonical query hash for persistent Apify dedupe (org + platform + query + caps). */
export function hashApifyCanonicalQuery(input: {
  organisationId: string;
  platform: SourcePlatform;
  query: string;
  actorId: string;
  limit: number;
  nicheHint?: string | null;
  recent?: boolean;
}): string {
  const payload = JSON.stringify({
    v: 1,
    organisationId: input.organisationId,
    platform: input.platform,
    query: input.query.trim().toLowerCase(),
    actorId: input.actorId,
    limit: input.limit,
    nicheHint: (input.nicheHint ?? "").trim().toLowerCase(),
    recent: input.recent ?? true,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function hashApifyInput(actorInput: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(actorInput)).digest("hex");
}

function rowToSourceResult(row: {
  url: string;
  title: string | null;
  platform: string;
  author: string | null;
  publishedAt: Date | null;
  content: string | null;
  engagement: unknown;
  rawMetadata: unknown;
}): SourceResult | null {
  if (!row.url?.trim()) return null;
  const platform = row.platform as SourcePlatform;
  return {
    url: row.url,
    title: row.title || row.url,
    content: row.content || "",
    author: row.author,
    publishedAt: row.publishedAt,
    platform,
    engagement:
      row.engagement && typeof row.engagement === "object"
        ? (row.engagement as SourceResult["engagement"])
        : null,
    rawMetadata:
      row.rawMetadata && typeof row.rawMetadata === "object"
        ? { ...(row.rawMetadata as Record<string, unknown>), persistentCacheHit: true }
        : { persistentCacheHit: true },
  };
}

/**
 * Before a paid Apify run, reuse fresh ResearchSource / Snapshot rows that match
 * the canonical query hash. In-memory cache remains a fast path; this is durable.
 */
export async function findFreshPersistentApifyCache(input: {
  organisationId: string;
  platform: SourcePlatform;
  canonicalQueryHash: string;
  limit: number;
  maxAgeMs?: number;
}): Promise<SourceResult[] | null> {
  const maxAgeMs = input.maxAgeMs ?? getSourceCacheTtlMs();
  const cutoff = new Date(Date.now() - maxAgeMs);

  try {
    const sources = await prisma.researchSource.findMany({
      where: {
        organisationId: input.organisationId,
        platform: input.platform,
        retrievedAt: { gte: cutoff },
        OR: [
          { rawMetadata: { path: ["canonicalQueryHash"], equals: input.canonicalQueryHash } },
          {
            rawMetadata: {
              path: ["apify", "canonicalQueryHash"],
              equals: input.canonicalQueryHash,
            },
          },
        ],
      },
      orderBy: { retrievedAt: "desc" },
      take: Math.max(input.limit, 1),
    });

    if (sources.length > 0) {
      const mapped = sources
        .map(rowToSourceResult)
        .filter((r): r is SourceResult => Boolean(r));
      if (mapped.length) return mapped.slice(0, input.limit);
    }

    const snapshots = await prisma.researchSourceSnapshot.findMany({
      where: {
        organisationId: input.organisationId,
        platform: input.platform,
        retrievedAt: { gte: cutoff },
        OR: [
          { rawMetadata: { path: ["canonicalQueryHash"], equals: input.canonicalQueryHash } },
          {
            rawMetadata: {
              path: ["apify", "canonicalQueryHash"],
              equals: input.canonicalQueryHash,
            },
          },
        ],
      },
      orderBy: { retrievedAt: "desc" },
      take: Math.max(input.limit, 1),
    });

    if (snapshots.length > 0) {
      const mapped = snapshots
        .map(rowToSourceResult)
        .filter((r): r is SourceResult => Boolean(r));
      if (mapped.length) return mapped.slice(0, input.limit);
    }
  } catch (error) {
    logger.warn("Persistent Apify cache lookup failed — continuing to live path", {
      organisationId: input.organisationId,
      platform: input.platform,
      message: error instanceof Error ? error.message : "unknown",
    });
  }

  return null;
}

export type ApifyProvenance = {
  /** Factual source platform (Instagram etc.) — Apify is only the retrieval mechanism. */
  sourcePlatform: SourcePlatform;
  retrievalMechanism: "apify";
  canonicalQueryHash: string;
  actorId: string;
  actorBuild: string;
  runId: string;
  inputHash: string;
  retrievedAt: string;
  actualCost: {
    usageTotalUsd: number | null;
    costCents: number;
  };
};

export function buildApifyProvenanceMetadata(input: {
  existing?: Record<string, unknown>;
  provenance: ApifyProvenance;
}): Record<string, unknown> {
  const p = input.provenance;
  return {
    ...(input.existing || {}),
    sourcePlatform: p.sourcePlatform,
    retrievalMechanism: "apify",
    canonicalQueryHash: p.canonicalQueryHash,
    apify: {
      actorId: p.actorId,
      actorBuild: p.actorBuild,
      runId: p.runId,
      inputHash: p.inputHash,
      retrievedAt: p.retrievedAt,
      actualCost: p.actualCost,
      canonicalQueryHash: p.canonicalQueryHash,
    },
    apifyRunId: p.runId,
    apifyCostCents: p.actualCost.costCents,
  };
}

/**
 * Proxy policy enforcement. Never defaults to residential. Social-session
 * cookies are not a normal path (denied when present in actor input).
 */
export function assertProxyPolicy(
  platform: SourcePlatform,
  policy: ApifyProxyPolicy,
  actorInput: Record<string, unknown>,
): void {
  const cookieKeys = ["cookies", "sessionCookies", "cookie", "loginCookies", "storageState"];
  for (const key of cookieKeys) {
    if (actorInput[key] != null && actorInput[key] !== "" && actorInput[key] !== false) {
      throw new ApifyDeniedError(
        platform,
        "PROXY_POLICY",
        `${platform} source does not accept social-session cookies.`,
      );
    }
  }

  // Do not inject residential proxies. Callers that require RESIDENTIAL_REQUIRED
  // must have already configured the actor input via approved buildInput only.
  if (policy === "RESIDENTIAL_REQUIRED") {
    const proxy = actorInput.proxyConfiguration ?? actorInput.proxy;
    const hasResidential =
      proxy &&
      typeof proxy === "object" &&
      ((proxy as { useApifyProxy?: boolean }).useApifyProxy === true ||
        String((proxy as { apifyProxyGroups?: unknown }).apifyProxyGroups || "")
          .toUpperCase()
          .includes("RESIDENTIAL"));
    if (!hasResidential) {
      // Policy documents requirement; buildInput owns wiring. Soft-log only —
      // we never silently upgrade NONE/DATACENTER to residential.
      logger.warn("Apify RESIDENTIAL_REQUIRED without residential proxyConfiguration", {
        platform,
      });
    }
  }
}

/**
 * Progressive depth: small sample first; broaden only when Quality Engine /
 * answerMode / governor say more is needed. Caps always respect hardMaxItems.
 */
export function resolveApifyProgressiveLimit(input: {
  defaultMaxItems: number;
  hardMaxItems: number;
  requestedLimit?: number;
  answerMode?: AgentAnswerModeLite | null;
  qualityBudget?: VerificationDepth | null;
  governorMode?: ComputeExecutionMode | null;
  broaden?: boolean;
}): number {
  const hard = Math.max(1, Math.floor(input.hardMaxItems));
  const defaults = Math.max(1, Math.min(Math.floor(input.defaultMaxItems), hard));
  const requested = Math.max(1, Math.floor(input.requestedLimit ?? defaults));

  let sample = Math.min(requested, defaults);

  const mode = input.governorMode;
  const budget = input.qualityBudget;
  const answer = input.answerMode;

  if (mode === "CACHE" || mode === "DETERMINISTIC" || mode === "ECONOMY") {
    sample = Math.min(sample, 3);
  } else if (mode === "STANDARD") {
    sample = Math.min(sample, Math.max(3, Math.ceil(defaults / 2)));
  }

  if (budget === "FAST") sample = Math.min(sample, 3);
  else if (budget === "STANDARD") sample = Math.min(sample, Math.max(3, Math.ceil(defaults / 2)));

  if (answer === "QUICK" || answer === "EXECUTIVE") sample = Math.min(sample, 3);
  else if (answer === "ACTION") sample = Math.min(sample, Math.max(3, Math.ceil(defaults / 2)));

  if (input.broaden) {
    sample = Math.min(hard, Math.max(sample, defaults, requested));
  }

  return Math.max(1, Math.min(sample, hard, requested));
}

export function clampApifyMaxItems(limit: number, hardMaxItems: number): number {
  return Math.max(1, Math.min(Math.floor(limit), Math.floor(hardMaxItems)));
}

export function estimateMaxTotalChargeUsd(input: {
  estimatedUnitCost: number;
  maxItems: number;
  /** Safety multiplier on estimate — actual completed-run usage is authoritative. */
  safetyFactor?: number;
}): number {
  const per1k = Math.max(0, input.estimatedUnitCost);
  const units = Math.max(1, input.maxItems);
  const raw = (units * per1k) / 1000;
  const factor = input.safetyFactor ?? 1.5;
  // Floor at $0.01 so Apify accepts the cap; ceil to 2 decimals.
  return Math.max(0.01, Math.ceil(raw * factor * 100) / 100);
}
