/**
 * Process-local fatal Redis provider circuit.
 * Stops Agent Desk–owned Redis work when Upstash (etc.) returns quota command errors.
 * Not a distributed system — one latch per Node process.
 */

import { logger } from "@/lib/logger";

export type RedisCircuitState = "CLOSED" | "OPEN";

const FATAL_QUOTA_RE = /max\s+(?:daily\s+)?requests?\s+limit\s+exceeded/i;
/** Provider rate-limit replies, e.g. "ERR Your database has been temporarily rate-limited". */
const RATE_LIMIT_RE = /rate[\s-]?limit/i;
/** Redis error replies start with an upper-case error code such as `ERR`. */
const REDIS_ERR_REPLY_RE = /(?:^|[\s:])ERR\s/;

let state: RedisCircuitState = "CLOSED";
let openedAt: number | null = null;
let openReason: string | null = null;
let openTransitionCount = 0;
let suppressedWhileOpen = 0;
let lastReminderAt = 0;
let onOpenHook: (() => void | Promise<void>) | null = null;
let onRecoverHook: (() => void | Promise<void>) | null = null;
/** Failed recovery probes (and quick re-opens) since the circuit last settled. */
let recoveryAttempts = 0;
let nextProbeAt = 0;
let lastRecoveredAt = 0;

/** Optional low-frequency reminder while OPEN (default 15 minutes). */
const REMINDER_MS = Number(process.env.REDIS_CIRCUIT_REMINDER_MS || 15 * 60_000);
/** First recovery probe delay after OPEN; doubles per failed probe (default 5 minutes). */
const RECOVERY_BASE_MS = Number(process.env.REDIS_CIRCUIT_RECOVERY_INTERVAL_MS || 5 * 60_000);
const RECOVERY_MAX_MS = Number(process.env.REDIS_CIRCUIT_RECOVERY_MAX_MS || 60 * 60_000);
/** Re-opening within this window after a recovery keeps the longer back-off. */
const FLAP_WINDOW_MS = 10 * 60_000;

/**
 * Deterministic classifier for fatal provider-level Redis command replies:
 * quota exhaustion and provider rate limiting. Does NOT treat socket disconnects /
 * timeouts as fatal, and only treats "rate limit" as fatal when it is a Redis
 * `ERR …` reply (so an AI-provider 429 surfacing as a failed job never trips it).
 */
export function isFatalRedisProviderError(error: unknown): boolean {
  const msg = messageFromError(error);
  if (!msg) return false;
  // Exclude common transient connection patterns even if message is noisy.
  if (isTransientRedisNoise(msg)) return false;
  if (FATAL_QUOTA_RE.test(msg)) return true;
  return REDIS_ERR_REPLY_RE.test(msg) && RATE_LIMIT_RE.test(msg);
}

function recoveryDelayMs(): number {
  return Math.min(RECOVERY_BASE_MS * 2 ** Math.min(recoveryAttempts, 10), RECOVERY_MAX_MS);
}

/** True when the worker should spend one PING probing for recovery (exponential back-off). */
export function isRedisRecoveryProbeDue(now = Date.now()): boolean {
  return state === "OPEN" && now >= nextProbeAt;
}

/** Record a failed recovery probe — the next probe waits twice as long (capped). */
export function noteRedisRecoveryProbeFailed(now = Date.now()): void {
  if (state !== "OPEN") return;
  recoveryAttempts += 1;
  nextProbeAt = now + recoveryDelayMs();
}

function messageFromError(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(error);
}

function isTransientRedisNoise(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("socket closed") ||
    m.includes("connection is closed") ||
    m.includes("connect econn") ||
    m.includes("read econn")
  );
}

export function getRedisCircuitState(): RedisCircuitState {
  return state;
}

export function isRedisCircuitOpen(): boolean {
  return state === "OPEN";
}

export function getRedisCircuitSnapshot(): {
  state: RedisCircuitState;
  openedAt: string | null;
  openReason: string | null;
  openTransitionCount: number;
  suppressedWhileOpen: number;
} {
  return {
    state,
    openedAt: openedAt ? new Date(openedAt).toISOString() : null,
    openReason,
    openTransitionCount,
    suppressedWhileOpen,
  };
}

/**
 * Register worker-side hooks (pause / resume BullMQ). One registration each.
 */
export function setRedisCircuitHooks(hooks: {
  onOpen?: (() => void | Promise<void>) | null;
  onRecover?: (() => void | Promise<void>) | null;
}): void {
  if (hooks.onOpen !== undefined) onOpenHook = hooks.onOpen;
  if (hooks.onRecover !== undefined) onRecoverHook = hooks.onRecover;
}

/**
 * Observe a Redis error. Opens the circuit once on fatal provider quota errors.
 * @returns true if this call newly transitioned CLOSED → OPEN
 */
export function noteRedisError(error: unknown): boolean {
  if (!isFatalRedisProviderError(error)) {
    return false;
  }

  if (state === "OPEN") {
    suppressedWhileOpen += 1;
    maybeRemind();
    return false;
  }

  state = "OPEN";
  openedAt = Date.now();
  openReason = messageFromError(error).slice(0, 240);
  openTransitionCount += 1;
  suppressedWhileOpen = 0;
  lastReminderAt = Date.now();
  // Flapping (re-opened soon after a recovery) keeps growing the back-off.
  if (lastRecoveredAt && openedAt - lastRecoveredAt < FLAP_WINDOW_MS) {
    recoveryAttempts += 1;
  } else {
    recoveryAttempts = 0;
  }
  nextProbeAt = openedAt + recoveryDelayMs();

  logger.error("Redis fatal provider circuit OPEN — stopping BullMQ Redis traffic", {
    code: "REDIS_PROVIDER_QUOTA",
    reason: openReason,
    openTransitionCount,
    nextProbeInMs: nextProbeAt - openedAt,
  });

  try {
    const maybe = onOpenHook?.();
    if (maybe != null && typeof (maybe as PromiseLike<void>).then === "function") {
      void Promise.resolve(maybe).catch((hookErr) => {
        logger.error("Redis circuit onOpen hook failed", {
          message: hookErr instanceof Error ? hookErr.message : "unknown",
        });
      });
    }
  } catch (hookErr) {
    logger.error("Redis circuit onOpen hook failed", {
      message: hookErr instanceof Error ? hookErr.message : "unknown",
    });
  }

  return true;
}

function maybeRemind(): void {
  const now = Date.now();
  if (now - lastReminderAt < REMINDER_MS) return;
  lastReminderAt = now;
  logger.warn("Redis fatal provider circuit still OPEN", {
    code: "REDIS_PROVIDER_QUOTA",
    suppressedWhileOpen,
    openReason,
    openedAt: openedAt ? new Date(openedAt).toISOString() : null,
  });
}

/**
 * Clear circuit after a successful recovery probe. Idempotent.
 * @returns true if this call newly transitioned OPEN → CLOSED
 */
export function clearRedisCircuit(reason = "recovery_probe_ok"): boolean {
  if (state !== "OPEN") return false;
  const wasOpenedAt = openedAt;
  state = "CLOSED";
  openedAt = null;
  lastRecoveredAt = Date.now();
  const previousReason = openReason;
  openReason = null;

  logger.info("Redis fatal provider circuit RECOVERED", {
    code: "REDIS_PROVIDER_QUOTA_RECOVERED",
    reason,
    previousReason,
    openedAt: wasOpenedAt ? new Date(wasOpenedAt).toISOString() : null,
    suppressedWhileOpen,
  });
  suppressedWhileOpen = 0;

  try {
    const maybe = onRecoverHook?.();
    if (maybe != null && typeof (maybe as PromiseLike<void>).then === "function") {
      void Promise.resolve(maybe).catch((hookErr) => {
        logger.error("Redis circuit onRecover hook failed", {
          message: hookErr instanceof Error ? hookErr.message : "unknown",
        });
      });
    }
  } catch (hookErr) {
    logger.error("Redis circuit onRecover hook failed", {
      message: hookErr instanceof Error ? hookErr.message : "unknown",
    });
  }

  return true;
}

/** Fail-closed gate for enqueue / Redis-dependent sweeps. */
export function assertRedisCircuitAllowsWork(): void {
  if (state === "OPEN") {
    throw new RedisCircuitOpenError(
      "Redis provider circuit is OPEN (quota / fatal provider error). Agent-runs queue unavailable.",
    );
  }
}

export class RedisCircuitOpenError extends Error {
  readonly code = "REDIS_CIRCUIT_OPEN";
  constructor(message: string) {
    super(message);
    this.name = "RedisCircuitOpenError";
  }
}

/** Test helper */
export function resetRedisCircuitForTests(): void {
  state = "CLOSED";
  openedAt = null;
  openReason = null;
  openTransitionCount = 0;
  suppressedWhileOpen = 0;
  lastReminderAt = 0;
  onOpenHook = null;
  onRecoverHook = null;
  recoveryAttempts = 0;
  nextProbeAt = 0;
  lastRecoveredAt = 0;
}
