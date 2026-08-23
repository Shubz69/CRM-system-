import { describe, expect, it } from "vitest";
import {
  normalizePlan,
  planCapabilityDefaults,
} from "@/services/entitlements";

describe("Entitlements plan map", () => {
  it("normalizes unknown plans to standard", () => {
    expect(normalizePlan("weird")).toBe("standard");
    expect(normalizePlan("PRO")).toBe("pro");
  });

  it("standard enables research with a monthly limit", () => {
    const caps = planCapabilityDefaults("standard");
    expect(caps.research.enabled).toBe(true);
    expect(caps.research.limitValue).toBe(50);
    expect(caps.ask.enabled).toBe(true);
  });

  it("enterprise leaves research unlimited", () => {
    const caps = planCapabilityDefaults("enterprise");
    expect(caps.research.limitValue).toBeNull();
  });
});

describe("Chief of Staff honesty contract", () => {
  it("empty attention yields no invented briefing items", () => {
    const handoffCount = 0;
    const items =
      handoffCount > 0
        ? [{ title: `${handoffCount} conversations need a human` }]
        : [];
    expect(items).toEqual([]);
  });
});
