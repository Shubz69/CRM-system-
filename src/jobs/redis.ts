/**
 * Redis / BullMQ connection helpers.
 * Never log REDIS_URL or tokens.
 *
 * P0 cost controls:
 * - Dev/test must not hit Upstash unless ALLOW_REMOTE_REDIS_IN_DEV=true
 * - pingRedis uses a short-lived cache; does not open a new connection every call when shared exists
 * - Environment isolation uses BullMQ's native `prefix` option (never put ":" in queue names)
 */

import IORedis, { type RedisOptions } from "ioredis";
import { logger } from "@/lib/logger";
import { getRuntimeMode, isProductionRuntime } from "@/lib/runtime";
import {
  isFatalRedisProviderError,
  isRedisCircuitOpen,
  noteRedisError,
} from "@/jobs/redis-circuit";

let shared: IORedis | null = null;
let lastPingAt = 0;
let lastPingOk = false;
const PING_CACHE_MS = 5_000;

export class RemoteRedisInDevError extends Error {
  readonly code = "REMOTE_REDIS_IN_DEV";
  constructor(message: string) {
    super(message);
    this.name = "RemoteRedisInDevError";
  }
}

/**
 * Accept a real redis:// / rediss:// URL.
 * Also recovers the common mistake of pasting a full `redis-cli --tls -u …` command.
 * Default is local Docker Redis — never Upstash.
 */
export function getRedisUrl(): string {
  const raw = (process.env.REDIS_URL || "redis://localhost:6379").trim();
  const embedded = raw.match(/rediss?:\/\/\S+/i);
  let url = embedded ? embedded[0].replace(/[>"']+$/, "") : raw;
  if (/^redis:\/\//i.test(url) && /upstash\.io/i.test(url)) {
    url = url.replace(/^redis:\/\//i, "rediss://");
  }
  return url;
}

export function isRemoteUpstashUrl(url: string): boolean {
  return /upstash\.io/i.test(url);
}

/**
 * Refuse Upstash (or other remote Redis) from local/dev/test unless explicitly opted in.
 * Does not log the URL.
 */
export function assertRedisUrlAllowedForRuntime(): void {
  const mode = getRuntimeMode();
  if (mode === "production") return;
  const url = getRedisUrl();
  if (!isRemoteUpstashUrl(url)) return;
  if (process.env.ALLOW_REMOTE_REDIS_IN_DEV === "true") {
    logger.warn(
      "ALLOW_REMOTE_REDIS_IN_DEV=true — local process is using remote Redis. Prefer docker compose Redis.",
    );
    return;
  }
  throw new RemoteRedisInDevError(
    "REDIS_URL points at Upstash while runtime is development/test. " +
      "Use redis://localhost:6379 (docker compose up redis) or set ALLOW_REMOTE_REDIS_IN_DEV=true only if intentional.",
  );
}

/**
 * Authoritative BullMQ Redis key prefix (NOT part of the queue name).
 * BullMQ forbids ":" in queue names; isolation belongs here.
 *
 * Resolution:
 * 1. QUEUE_PREFIX if explicitly set (colons normalized to hyphens)
 * 2. otherwise agentdesk-{dev|test|preview|prod}
 */
export function getBullMqPrefix(): string {
  const explicit = (process.env.QUEUE_PREFIX || "").trim();
  if (explicit) {
    const normalized = explicit.replace(/:/g, "-").replace(/-+$/g, "").replace(/^-+/g, "");
    return normalized || "agentdesk-dev";
  }
  const mode = getRuntimeMode();
  if (mode === "production") return "agentdesk-prod";
  if (mode === "test") return "agentdesk-test";
  if (process.env.VERCEL_ENV === "preview") return "agentdesk-preview";
  return "agentdesk-dev";
}

/** @deprecated use getBullMqPrefix — same value (BullMQ `prefix`, not queue name). */
export function getQueuePrefix(): string {
  return getBullMqPrefix();
}

/**
 * BullMQ custom jobIds must not contain ":".
 * Keeps idempotency keys stable while remaining Redis-safe.
 */
export function toSafeBullMqJobId(...parts: Array<string | number | null | undefined>): string {
  const cleaned = parts
    .map((p) => (p == null ? "" : String(p)))
    .map((p) => p.replace(/:/g, "-").trim())
    .filter(Boolean);
  if (cleaned.length === 0) {
    throw new Error("toSafeBullMqJobId requires at least one non-empty part");
  }
  return cleaned.join("-");
}

/** Idempotent mission / agent-run job ids (no colons). */
export function missionAgentRunJobId(organisationId: string, missionId: string): string {
  return toSafeBullMqJobId("org", organisationId, "mission", missionId, "agent-run");
}

export function missionTaskJobId(organisationId: string, taskId: string): string {
  return toSafeBullMqJobId("org", organisationId, "task", taskId);
}

function redisConnectionOptions(url: string, overrides: RedisOptions = {}): RedisOptions {
  const isTls = /^rediss:\/\//i.test(url);
  const insecure =
    process.env.REDIS_TLS_INSECURE === "true" ||
    (!isProductionRuntime() && isTls) ||
    (isTls && /upstash\.io/i.test(url) && process.env.VERCEL === "1");

  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...(isTls
      ? {
          tls: {
            rejectUnauthorized: !insecure,
          },
        }
      : {}),
    ...overrides,
  };
}

/**
 * Shared BullMQ-compatible Redis connection.
 * Call assertRedisUrlAllowedForRuntime before connecting in workers.
 */
export function getRedisConnection(opts?: { lazyConnect?: boolean }): IORedis {
  if (!shared) {
    assertRedisUrlAllowedForRuntime();
    const url = getRedisUrl();
    shared = new IORedis(
      url,
      redisConnectionOptions(url, {
        lazyConnect: opts?.lazyConnect ?? false,
      }),
    );
    shared.on("error", (err) => {
      if (noteRedisError(err)) {
        return;
      }
      if (isFatalRedisProviderError(err) && isRedisCircuitOpen()) {
        // Deduplicated — circuit already OPEN.
        return;
      }
      logger.error("Redis connection error", { message: err.message });
    });
  }
  return shared;
}

/**
 * Lightweight ping. Prefers shared connection; caches result briefly to avoid
 * connect storms from health/enqueue paths.
 *
 * When the fatal provider circuit is OPEN, returns false without Redis traffic
 * unless `bypassCircuit` is set (recovery probe only).
 */
export async function pingRedis(
  timeoutMs = 2000,
  opts?: { bypassCircuit?: boolean },
): Promise<boolean> {
  if (!opts?.bypassCircuit && isRedisCircuitOpen()) {
    return false;
  }

  const now = Date.now();
  if (!opts?.bypassCircuit && now - lastPingAt < PING_CACHE_MS) {
    return lastPingOk;
  }

  try {
    assertRedisUrlAllowedForRuntime();
  } catch (error) {
    if (error instanceof RemoteRedisInDevError) {
      logger.warn("Redis ping skipped — remote Redis blocked in this runtime");
      lastPingAt = now;
      lastPingOk = false;
      return false;
    }
    throw error;
  }

  const url = getRedisUrl();
  if (!/^rediss?:\/\//i.test(url.trim())) {
    logger.warn("REDIS_URL is not a redis:// or rediss:// URL — treating Redis as down");
    lastPingAt = now;
    lastPingOk = false;
    return false;
  }

  // Reuse shared connection when already open (no extra TCP handshake).
  if (shared && shared.status === "ready") {
    try {
      const pong = await shared.ping();
      lastPingOk = pong === "PONG";
      lastPingAt = now;
      return lastPingOk;
    } catch (error) {
      noteRedisError(error);
      /* fall through to ephemeral */
    }
  }

  let client: IORedis | null = null;
  try {
    client = new IORedis(
      url,
      redisConnectionOptions(url, {
        maxRetriesPerRequest: 1,
        connectTimeout: timeoutMs,
        lazyConnect: true,
        enableOfflineQueue: false,
      }),
    );
    await client.connect();
    const pong = await client.ping();
    lastPingOk = pong === "PONG";
    lastPingAt = now;
    return lastPingOk;
  } catch (error) {
    noteRedisError(error);
    if (!(isFatalRedisProviderError(error) && isRedisCircuitOpen())) {
      logger.warn("Redis ping failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
    lastPingOk = false;
    lastPingAt = now;
    return false;
  } finally {
    if (client) {
      await client.quit().catch(() => undefined);
    }
  }
}

/** Production requires Redis. Dev/test may fall back to in-process loops. */
export function redisRequired(): boolean {
  return isProductionRuntime();
}

export function assertRedisAllowedFallback(): void {
  if (redisRequired()) {
    throw new Error(
      "Redis is required in production. Set REDIS_URL and run the worker process. In-process fallback is disabled.",
    );
  }
  logger.error(
    "⚠️  IN-PROCESS JOB FALLBACK ACTIVE — Redis unavailable. " +
      `Runtime=${getRuntimeMode()}. Long jobs (agent-runs) will NOT run. ` +
      "This path is for local development only.",
  );
}

export function cronFallbackEnabled(): boolean {
  return process.env.CRON_FALLBACK_ENABLED === "true";
}

export async function closeRedisConnection(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => undefined);
    shared = null;
  }
  lastPingAt = 0;
  lastPingOk = false;
}

/** Test helper */
export function resetRedisPingCache(): void {
  lastPingAt = 0;
  lastPingOk = false;
}
