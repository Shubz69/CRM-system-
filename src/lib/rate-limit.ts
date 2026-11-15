type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Expired buckets are dropped once the map grows past this, at most once per sweep interval. */
const SWEEP_THRESHOLD = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

function sweepExpiredBuckets(now: number) {
  if (buckets.size < SWEEP_THRESHOLD || now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Simple in-memory rate limiter for webhook/API protection in a single process.
 * Replace with Redis-backed limiting in multi-instance production.
 * Keys can carry caller-supplied values (IP, email, token hash), so expired buckets are swept
 * instead of accumulating for the life of the process.
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweepExpiredBuckets(now);
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}
