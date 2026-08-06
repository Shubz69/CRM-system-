import { describe, expect, it } from "vitest";
import {
  evaluateMessagingWindow,
  openMessagingWindows,
  formatDurationRemaining,
  AUTOMATED_MESSAGING_WINDOW_MS,
} from "@/lib/messaging-window";

describe("messaging window", () => {
  it("opens a 24h automated window on inbound", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const windows = openMessagingWindows(now);
    expect(windows.messagingWindowExpiresAt.getTime() - now.getTime()).toBe(
      AUTOMATED_MESSAGING_WINDOW_MS,
    );
  });

  it("blocks automated replies after expiry", () => {
    const lastInbound = new Date("2026-01-01T00:00:00.000Z");
    const state = evaluateMessagingWindow({
      lastInboundAt: lastInbound,
      messagingWindowExpiresAt: new Date("2026-01-01T12:00:00.000Z"),
      humanMessagingWindowExpiresAt: new Date("2026-01-08T00:00:00.000Z"),
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(state.automatedReplyAllowed).toBe(false);
    expect(state.humanReplyAllowed).toBe(true);
    expect(state.automatedBlockedReason).toMatch(/window/i);
  });

  it("blocks AI when paused even inside the window", () => {
    const now = new Date();
    const windows = openMessagingWindows(now);
    const state = evaluateMessagingWindow({
      ...windows,
      aiPaused: true,
      now,
    });
    expect(state.automatedReplyAllowed).toBe(false);
    expect(state.automatedBlockedReason).toMatch(/paused/i);
  });

  it("formats remaining duration", () => {
    expect(formatDurationRemaining(0)).toBe("Expired");
    expect(formatDurationRemaining(90 * 60 * 1000)).toMatch(/1h/);
  });
});
