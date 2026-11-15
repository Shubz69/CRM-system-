import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimit } from "@/lib/rate-limit";

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("allows up to the limit per window, then resets", () => {
    expect(rateLimit("rl-test:a", 2, 60_000)).toBe(true);
    expect(rateLimit("rl-test:a", 2, 60_000)).toBe(true);
    expect(rateLimit("rl-test:a", 2, 60_000)).toBe(false);
    expect(rateLimit("rl-test:b", 2, 60_000)).toBe(true);
    vi.advanceTimersByTime(60_001);
    expect(rateLimit("rl-test:a", 2, 60_000)).toBe(true);
  });

  it("keeps limiting live keys when expired buckets are swept", () => {
    expect(rateLimit("rl-test:live", 1, 10 * 60_000)).toBe(true);
    expect(rateLimit("rl-test:live", 1, 10 * 60_000)).toBe(false);
    for (let i = 0; i < 10_000; i += 1) rateLimit(`rl-test:old:${i}`, 1, 1_000);
    vi.advanceTimersByTime(2 * 60_000);

    expect(rateLimit("rl-test:live", 1, 10 * 60_000)).toBe(false);
    expect(rateLimit("rl-test:old:1", 1, 1_000)).toBe(true);
  });
});
