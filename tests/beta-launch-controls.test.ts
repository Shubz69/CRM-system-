/**
 * Org rate limits, prospecting cost clamp, beta AI budget defaults.
 * NOT LIVE_E2E.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", () => {
  const counts = new Map<string, number>();
  return {
    rateLimit: (key: string, limit: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n <= limit;
    },
    __reset: () => counts.clear(),
  };
});

import { assertOrgExpensiveRouteAllowed, OrgRateLimitError } from "@/lib/org-rate-limit";
import { mergeDiscoveryCostLimits } from "@/services/social-prospecting/types";
import {
  BETA_ORG_AI_MONTHLY_CAP_CENTS,
  CUSTOMER_AI_ALLOWANCE_EXCEEDED,
  SpendCapExceededError,
} from "@/services/ai-spend-gate";
import { BETA_DEFAULT_AI_MONTHLY_CAP_CENTS } from "@/services/beta-workspace";
import { computeHintsForAnswerMode } from "@/services/answer-modes";

describe("org expensive route rate limits", () => {
  it("allows under limit then throws OrgRateLimitError", () => {
    const org = `org_rl_${Date.now()}`;
    for (let i = 0; i < 30; i++) {
      expect(() => assertOrgExpensiveRouteAllowed(org, "ask")).not.toThrow();
    }
    expect(() => assertOrgExpensiveRouteAllowed(org, "ask")).toThrow(OrgRateLimitError);
  });

  it("isolates limits per organisation and route", () => {
    expect(() => assertOrgExpensiveRouteAllowed("org_x", "content")).not.toThrow();
    expect(() => assertOrgExpensiveRouteAllowed("org_y", "content")).not.toThrow();
    expect(() => assertOrgExpensiveRouteAllowed("org_x", "research")).not.toThrow();
  });
});

describe("prospecting cost clamp", () => {
  it("clamps client overrides that exceed server ceiling", () => {
    const merged = mergeDiscoveryCostLimits(5, {
      maxCandidates: 999,
      maxSources: 999,
      maxExternalCalls: 999,
      maxEstimatedCostCents: 50_000,
      maxResearchDepth: "DEEP",
    });
    expect(merged.maxCandidates).toBeLessThanOrEqual(20);
    expect(merged.maxSources).toBeLessThanOrEqual(12);
    expect(merged.maxExternalCalls).toBeLessThanOrEqual(10);
    expect(merged.maxEstimatedCostCents).toBeLessThanOrEqual(100);
  });

  it("does not raise defaults when overrides are omitted", () => {
    const merged = mergeDiscoveryCostLimits(3);
    expect(merged.maxEstimatedCostCents).toBeLessThanOrEqual(100);
    expect(merged.maxCandidates).toBeLessThanOrEqual(20);
  });
});

describe("beta AI budget defaults", () => {
  it("uses the same $25 beta monthly cap constant", () => {
    expect(BETA_ORG_AI_MONTHLY_CAP_CENTS).toBe(2_500);
    expect(BETA_DEFAULT_AI_MONTHLY_CAP_CENTS).toBe(BETA_ORG_AI_MONTHLY_CAP_CENTS);
  });

  it("SpendCapExceededError exposes customer-safe message", () => {
    const err = new SpendCapExceededError("Organisation AI spend cap exceeded (900¢ / 500¢)", "org_a", 900, 500);
    expect(err.toCustomerMessage()).not.toMatch(/anthropic|openai|claude|¢/i);
    expect(err.toCustomerMessage().length).toBeGreaterThan(20);
    expect(CUSTOMER_AI_ALLOWANCE_EXCEEDED.length).toBeGreaterThan(10);
  });
});

describe("answer mode compute hints are distinct", () => {
  it("QUICK / EXECUTIVE / ACTION / DEEP produce meaningfully different plans", () => {
    const quick = computeHintsForAnswerMode("QUICK");
    const executive = computeHintsForAnswerMode("EXECUTIVE");
    const action = computeHintsForAnswerMode("ACTION", "HIGH");
    const deep = computeHintsForAnswerMode("DEEP");

    expect(quick.verificationBudget).toBe("FAST");
    expect(executive.verificationBudget).toBe("STANDARD");
    expect(deep.verificationBudget).toBe("DEEP");
    expect(quick.complexity).not.toBe(deep.complexity);
    expect(quick.contextBudget).toBeLessThan(executive.contextBudget!);
    expect(executive.contextBudget!).toBeLessThan(deep.contextBudget!);
    expect(action.complexity).toBe("HIGH");
    expect(quick.preferCache).toBe(true);
    expect(deep.preferCache).toBe(false);
  });
});
