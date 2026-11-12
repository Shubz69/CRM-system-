"use client";

import { useEffect, useRef } from "react";

/**
 * Polling that is cheap for the server:
 * - skips ticks while the tab is hidden (background tabs used to poll forever),
 * - never overlaps a slow request with the next tick,
 * - refreshes once as soon as the tab becomes visible again.
 */
export function useVisibleInterval(
  callback: () => Promise<unknown> | unknown,
  intervalMs: number,
  enabled = true,
): void {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let stopped = false;

    const run = async () => {
      if (running || stopped) return;
      running = true;
      try {
        await callbackRef.current();
      } catch {
        // Keep previous data; the next tick retries.
      } finally {
        running = false;
      }
    };

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        timer = null;
        if (!document.hidden) await run();
        schedule();
      }, intervalMs);
    };

    const onVisibilityChange = () => {
      if (!document.hidden) void run();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
