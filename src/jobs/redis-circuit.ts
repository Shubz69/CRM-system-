/**
 * Process-local fatal Redis provider circuit.
 * Stops Agent Desk–owned Redis work when Upstash (etc.) returns quota command errors.
 * Not a distributed system — one latch per Node process.
 */

import { logger } from "@/lib/logger";

export type RedisCircuitState = "CLOSED" | "OPEN";

const FATAL_QUOTA_RE = /max\s+requests\s+limit\s+exceeded/i;

let state: RedisCircuitState = "CLOSED";
let openedAt: number | null = null;
let openReason: string | null = null;
let openTransitionCount = 0;
let suppressedWhileOpen = 0;
let lastReminderAt = 0;
let onOpenHook: (() => void | Promise<void>) | null = null;
let onRecoverHook: (() => void | Promise<void>) | null = null;

/** Optional low-frequency reminder while OPEN (default 15 minutes). */
const REMINDER_MS = Number(process.env.REDIS_CIRCUIT_REMINDER_MS || 15 * 60_000);

/**
 * Deterministic classifier for fatal provider-level Redis command replies.
 * Does NOT treat socket disconnects / timeouts as fatal.
 */
export function isFatalRedisProviderError(error: unknown): boolean {
  const msg = messageFromError(error);
  if (!msg) return false;
  // Exclude common transient connection patterns even if message is noisy.
  if (isTransientRedisNoise(msg)) return false;
  return FATAL_QUOTA_RE.test(msg);
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

  logger.error("Redis fatal provider circuit OPEN — stopping BullMQ Redis traffic", {
    code: "REDIS_PROVIDER_QUOTA",
    reason: openReason,
    openTransitionCount,
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
}
