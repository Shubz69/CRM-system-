/**
 * DomainEvent status transitions — controlled, not free-form.
 */

import type { DomainEventStatus } from "@prisma/client";

export class InvalidDomainEventTransitionError extends Error {
  readonly code = "INVALID_DOMAIN_EVENT_TRANSITION";
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid DomainEvent transition ${from} → ${to}`);
    this.name = "InvalidDomainEventTransitionError";
  }
}

const TRANSITIONS: Record<DomainEventStatus, readonly DomainEventStatus[]> = {
  PENDING: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PROCESSED", "RETRY", "DEAD_LETTER", "CANCELLED"],
  RETRY: ["PROCESSING", "DEAD_LETTER", "CANCELLED"],
  PROCESSED: [],
  DEAD_LETTER: ["RETRY", "CANCELLED"], // manual retry only
  CANCELLED: [],
};

export function assertDomainEventTransition(
  from: DomainEventStatus,
  to: DomainEventStatus,
): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidDomainEventTransitionError(from, to);
  }
}

/** Exponential backoff with jitter (ms). */
export function nextRetryDelayMs(attemptCount: number): number {
  const base = Math.min(60 * 60_000, 2_000 * Math.pow(2, Math.max(0, attemptCount - 1)));
  const jitter = Math.floor(Math.random() * Math.min(5_000, base * 0.2));
  return base + jitter;
}

export type OutboxErrorClass = "TRANSIENT" | "PERMANENT";

export function classifyOutboxError(error: unknown): OutboxErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

  if (
    code === "UNSUPPORTED_EVENT_VERSION" ||
    code === "MISSION_PERMISSION" ||
    /permission|forbidden|unauthorized|invalid payload|validation/i.test(message)
  ) {
    return "PERMANENT";
  }
  if (/429|timeout|ECONNRESET|5\d\d|temporarily|unavailable|deadlock/i.test(message)) {
    return "TRANSIENT";
  }
  // Default transient so ops can inspect; maxAttempts still dead-letters.
  return "TRANSIENT";
}
