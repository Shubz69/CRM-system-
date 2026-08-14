import IORedis, { type RedisOptions } from "ioredis";
import { logger } from "@/lib/logger";
import { getRuntimeMode, isProductionRuntime } from "@/lib/runtime";

let shared: IORedis | null = null;

/**
 * Accept a real redis:// / rediss:// URL.
 * Also recovers the common mistake of pasting a full `redis-cli --tls -u …` command.
 */
export function getRedisUrl(): string {
  const raw = (process.env.REDIS_URL || "redis://localhost:6379").trim();
  const embedded = raw.match(/rediss?:\/\/\S+/i);
  let url = embedded ? embedded[0].replace(/[>"']+$/, "") : raw;
  // Upstash requires TLS — upgrade accidental redis:// to rediss://
  if (/^redis:\/\//i.test(url) && /upstash\.io/i.test(url)) {
    url = url.replace(/^redis:\/\//i, "rediss://");
  }
  return url;
}

function redisConnectionOptions(url: string, overrides: RedisOptions = {}): RedisOptions {
  const isTls = /^rediss:\/\//i.test(url);
  const insecure =
    process.env.REDIS_TLS_INSECURE === "true" ||
    // Local Windows / corporate proxies often break Upstash cert verification.
    (!isProductionRuntime() && isTls) ||
    // Upstash on some serverless runtimes also needs this when the CA chain fails.
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
 * maxRetriesPerRequest must be null for BullMQ workers.
 */
export function getRedisConnection(opts?: { lazyConnect?: boolean }): IORedis {
  if (!shared) {
    const url = getRedisUrl();
    shared = new IORedis(
      url,
      redisConnectionOptions(url, {
        lazyConnect: opts?.lazyConnect ?? false,
      }),
    );
    shared.on("error", (err) => {
      logger.error("Redis connection error", { message: err.message });
    });
  }
  return shared;
}

export async function pingRedis(timeoutMs = 2000): Promise<boolean> {
  let client: IORedis | null = null;
  try {
    const url = getRedisUrl();
    // Reject clearly non-URL values (e.g. a pasted `redis-cli …` without a URL).
    if (!/^rediss?:\/\//i.test(url.trim())) {
      logger.warn("REDIS_URL is not a redis:// or rediss:// URL — treating Redis as down");
      return false;
    }
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
    return pong === "PONG";
  } catch (error) {
    logger.warn("Redis ping failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
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

export async function closeRedisConnection(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => undefined);
    shared = null;
  }
}
