/**
 * Sliding-window rate limiter — counts requests per key, no fixed sleep loops.
 * tryAcquire returns false immediately when the window is full.
 */
type WindowState = {
  timestamps: number[];
};

const windows = new Map<string, WindowState>();

export function tryAcquireRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const state = windows.get(input.key) ?? { timestamps: [] };
  state.timestamps = state.timestamps.filter((t) => now - t < input.windowMs);
  if (state.timestamps.length >= input.limit) {
    windows.set(input.key, state);
    return false;
  }
  state.timestamps.push(now);
  windows.set(input.key, state);
  return true;
}

/** Test helper */
export function clearSourceRateLimits(): void {
  windows.clear();
}

export function msUntilRateLimitReset(input: {
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  const state = windows.get(input.key);
  if (!state || state.timestamps.length < input.limit) return 0;
  const oldest = state.timestamps[0];
  if (oldest == null) return 0;
  return Math.max(0, input.windowMs - (now - oldest));
}
