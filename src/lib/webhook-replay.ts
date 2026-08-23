/**
 * Webhook replay protection helpers.
 * Complements WebhookEvent idempotencyKey dedupe — rejects stale timestamps.
 */

export class WebhookReplayError extends Error {
  readonly code = "WEBHOOK_REPLAY";
  constructor(message: string) {
    super(message);
    this.name = "WebhookReplayError";
  }
}

const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Parse timestamp from common webhook headers / payload fields.
 * Accepts unix seconds, unix ms, or ISO-8601.
 */
export function parseWebhookTimestamp(
  raw: string | number | null | undefined,
): Date | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Reject events older/newer than maxSkewMs relative to now.
 * If no timestamp is provided, returns { ok: true, checked: false } —
 * callers must still rely on idempotency keys.
 */
export function assertWebhookTimestampFresh(input: {
  timestamp: string | number | null | undefined;
  maxSkewMs?: number;
  now?: Date;
}): { ok: true; checked: boolean; eventTime?: Date } {
  const eventTime = parseWebhookTimestamp(input.timestamp);
  if (!eventTime) {
    return { ok: true, checked: false };
  }
  const now = input.now ?? new Date();
  const skew = input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const delta = Math.abs(now.getTime() - eventTime.getTime());
  if (delta > skew) {
    throw new WebhookReplayError(
      `Webhook timestamp outside allowed window (${Math.round(delta / 1000)}s skew)`,
    );
  }
  return { ok: true, checked: true, eventTime };
}

export function readWebhookTimestampHeader(headers: Headers): string | null {
  return (
    headers.get("x-webhook-timestamp") ||
    headers.get("x-manychat-timestamp") ||
    headers.get("x-request-timestamp") ||
    headers.get("x-slack-request-timestamp") ||
    null
  );
}
