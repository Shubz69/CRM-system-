import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/services/ai-spend-gate", () => ({
  assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
  SpendCapExceededError: class SpendCapExceededError extends Error {
    code = "SPEND_CAP_EXCEEDED";
  },
}));

import { runWithZodRepair, completeStructuredSafe } from "@/adapters/ai/structured";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import {
  FORMAL_TO_LEGACY_TIER,
  resolveModelForTier,
  toFormalTier,
  toLegacyTier,
} from "@/lib/ai-models";
import type { AiProvider } from "@/adapters/ai/types";

describe("Formal AI tiers", () => {
  it("maps cheap/balanced/heavy onto economy/default/advanced", () => {
    expect(FORMAL_TO_LEGACY_TIER.cheap).toBe("economy");
    expect(FORMAL_TO_LEGACY_TIER.balanced).toBe("default");
    expect(FORMAL_TO_LEGACY_TIER.heavy).toBe("advanced");
    expect(toLegacyTier("cheap")).toBe("economy");
    expect(toFormalTier("advanced")).toBe("heavy");
  });

  it("resolves a model for every formal tier", () => {
    expect(resolveModelForTier("cheap")).toBeTruthy();
    expect(resolveModelForTier("balanced")).toBeTruthy();
    expect(resolveModelForTier("heavy")).toBeTruthy();
  });
});

describe("runWithZodRepair", () => {
  const schema = z.object({ message: z.string() });

  it("succeeds without repair when first value is valid", async () => {
    const result = await runWithZodRepair({
      schema,
      firstValue: { message: "ok" },
      repair: async () => ({ message: "repaired" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.message).toBe("ok");
    expect(result.repaired).toBe(false);
  });

  it("repairs once then succeeds", async () => {
    let repairs = 0;
    const result = await runWithZodRepair({
      schema,
      firstValue: { bad: true },
      repair: async () => {
        repairs += 1;
        return { message: "fixed" };
      },
    });
    expect(repairs).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(true);
    expect(result.data.message).toBe("fixed");
  });

  it("fails cleanly after one failed repair", async () => {
    const result = await runWithZodRepair({
      schema,
      firstValue: { bad: true },
      repair: async () => ({ still: "bad" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/repair/i);
  });
});

describe("completeStructuredSafe", () => {
  beforeEach(() => {
    vi.mocked(assertWithinSpendCap).mockClear();
    vi.mocked(assertWithinSpendCap).mockResolvedValue({
      ok: true,
      spentCents: 0,
      capCents: null,
    });
  });

  it("calls the spend gate before completion", async () => {
    const provider: AiProvider = {
      name: "test",
      async complete() {
        return JSON.stringify({ answer: "yes" });
      },
      async analyseConversation() {
        return {};
      },
    };

    const schema = z.object({ answer: z.string() });
    const result = await completeStructuredSafe(schema, {
      organisationId: "org_test",
      prompt: "Say yes",
      provider,
      tier: "cheap",
    });

    expect(assertWithinSpendCap).toHaveBeenCalledWith("org_test");
    expect(result.ok).toBe(true);
  });

  it("repairs invalid JSON once via complete()", async () => {
    let calls = 0;
    const provider: AiProvider = {
      name: "test",
      async complete() {
        calls += 1;
        if (calls === 1) return "not-json";
        return JSON.stringify({ answer: "repaired" });
      },
      async analyseConversation() {
        return {};
      },
    };

    const schema = z.object({ answer: z.string() });
    const result = await completeStructuredSafe(schema, {
      organisationId: "org_test",
      prompt: "Say yes",
      provider,
    });

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(true);
    expect(result.data.answer).toBe("repaired");
  });
});
