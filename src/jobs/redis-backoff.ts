/**
 * Redis back-off + log throttling helpers.
 *
 * A provider rate-limit reply (e.g. "ERR Your database has been temporarily
 * rate-limited") used to be retried by BullMQ's fetch loop with no delay and
 * logged on every attempt (~5/s), which kept the limit tripped. These helpers give
 * reconnects an exponential delay and let callers log a repeating error once per
 * window with a suppressed count.
 */

import { logger } from "@/lib/logger";

const RECONNECT_BASE_MS = Number(process.env.REDIS_RECONNECT_BASE_MS || 500);
const RECONNECT_MAX_MS = Number(process.env.REDIS_RECONNECT_MAX_MS || 30_000);

/**
 * ioredis `retryStrategy`: exponential (500ms, 1s, 2s … capped at 30s) with ±20%
 * jitter so many processes do not reconnect in lock-step. Never gives up.
 */
export function redisReconnectDelayMs(times: number): number {
  const attempt = Math.max(1, Math.floor(times));
  const exp = RECONNECT_BASE_MS * 2 ** Math.min(attempt - 1, 16);
  const capped = Math.min(exp, RECONNECT_MAX_MS);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(capped * jitter);
}

type ThrottleEntry = { lastLoggedAt: number; suppressed: number };

const DEFAULT_LOG_WINDOW_MS = Number(process.env.REDIS_ERROR_LOG_WINDOW_MS || 60_000);
const throttleEntries = new Map<string, ThrottleEntry>();

/**
 * Log `message` at most once per `windowMs` per key. Repeats inside the window are
 * counted and reported as `suppressedSinceLastLog` on the next emitted line.
 * @returns true when the line was emitted.
 */
export function logThrottled(
  level: "error" | "warn" | "info",
  key: string,
  message: string,
  meta: Record<string, unknown> = {},
  windowMs = DEFAULT_LOG_WINDOW_MS,
): boolean {
  const now = Date.now();
  const entry = throttleEntries.get(key);
  if (entry && now - entry.lastLoggedAt < windowMs) {
    entry.suppressed += 1;
    return false;
  }
  const suppressed = entry?.suppressed ?? 0;
  throttleEntries.set(key, { lastLoggedAt: now, suppressed: 0 });
  if (throttleEntries.size > 500) {
    for (const [k, e] of throttleEntries) {
      if (now - e.lastLoggedAt >= windowMs) throttleEntries.delete(k);
    }
  }
  logger[level](message, {
    ...meta,
    ...(suppressed > 0 ? { suppressedSinceLastLog: suppressed } : {}),
  });
  return true;
}

/** Stable throttle key for an error message (drops volatile numbers like usage counts). */
export function errorThrottleKey(prefix: string, error: unknown): string {
  const msg =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown";
  return `${prefix}:${msg.replace(/\d+/g, "#").slice(0, 120)}`;
}

/** Test helper */
export function resetLogThrottleForTests(): void {
  throttleEntries.clear();
}
