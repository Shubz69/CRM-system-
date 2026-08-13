import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImageSafetyError,
  assertImageBriefSafe,
  buildGenerationPromptFromBrief,
  estimateImageGenerationCostCents,
  imageBriefSchema,
} from "@/adapters/images";
import { resetEnvCache } from "@/lib/env";
import { planAgentRunDeterministic } from "@/agents/supervisor/plan";
import { ensureAgentsRegistered, resetAgentBootstrap } from "@/agents";

describe("image providers — config and safety", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
    vi.resetModules();
    resetAgentBootstrap();
  });

  it("throws an explicit error when IMAGE_PROVIDER is unset (no placeholder)", async () => {
    vi.stubEnv("IMAGE_PROVIDER", "none");
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    resetEnvCache();
    vi.resetModules();
    const mod = await import("@/adapters/images");
    expect(() => mod.getImageProvider()).toThrow(mod.ImageProviderNotConfiguredError);
    expect(() => mod.getImageProvider()).toThrow(/not configured/i);
  });

  it("refuses Anthropic / Claude as an image generation provider", async () => {
    vi.stubEnv("IMAGE_PROVIDER", "anthropic");
    resetEnvCache();
    vi.resetModules();
    const mod = await import("@/adapters/images");
    expect(() => mod.getImageProvider()).toThrow(/Claude does not generate images/i);
  });

  it("selects OpenAI when configured", async () => {
    vi.stubEnv("IMAGE_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    resetEnvCache();
    vi.resetModules();
    const { getImageProvider } = await import("@/adapters/images");
    const provider = getImageProvider();
    expect(provider.name).toBe("openai");
  });

  it("selects Gemini when configured", async () => {
    vi.stubEnv("IMAGE_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    resetEnvCache();
    vi.resetModules();
    const { getImageProvider } = await import("@/adapters/images");
    const provider = getImageProvider();
    expect(provider.name).toBe("gemini");
  });

  it("validates image briefs with Zod and builds prompts", () => {
    const brief = imageBriefSchema.parse({
      composition: "centred product on soft gradient",
      colourPalette: ["#1a1a1a", "#f5f0e8"],
      style: "editorial still life",
      subject: "ceramic mug",
      mood: "calm morning",
      textTreatment: "none",
      proposedPrompt: "A ceramic mug on a soft gradient, editorial still life, calm morning light",
      safety: {
        depictsRealPerson: false,
        depictsCopyrightedCharacterOrLogo: false,
      },
    });
    expect(buildGenerationPromptFromBrief(brief, "warmer")).toContain("ceramic mug");
    expect(
      buildGenerationPromptFromBrief(brief, "warmer", "Edited prompt for warmer tones please"),
    ).toBe("Edited prompt for warmer tones please");
  });

  it("flags unsafe briefs", () => {
    expect(() =>
      assertImageBriefSafe({
        composition: "x",
        colourPalette: ["red"],
        style: "x",
        subject: "x",
        mood: "x",
        textTreatment: "x",
        proposedPrompt: "enough chars here",
        safety: { depictsRealPerson: true, depictsCopyrightedCharacterOrLogo: false },
      }),
    ).toThrow(/SAFETY_REAL_PERSON/);
  });

  it("ImageSafetyError carries plain-English copy", () => {
    const err = new ImageSafetyError("Cannot use real people.", "Try a fictional character.");
    expect(err.userFacingMessage).toMatch(/real people/i);
    expect(err.alternativeSuggestion).toMatch(/fictional/i);
  });

  it("estimates cost from configured provider", () => {
    vi.stubEnv("IMAGE_PROVIDER", "openai");
    vi.stubEnv("OPENAI_IMAGE_COST_CENTS", "12");
    resetEnvCache();
    expect(estimateImageGenerationCostCents()).toBe(12);
  });

  it("plans imaging_analyze when a reference asset is present", () => {
    ensureAgentsRegistered();
    const plan = planAgentRunDeterministic("Make something like this, warmer tones", {
      organisationId: "org_1",
      referenceAssetId: "asset_ref_1",
    });
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    expect(plan.plan.steps[0]?.agentName).toBe("imaging_analyze");
    expect(plan.plan.steps[0]?.input).toMatchObject({
      referenceAssetId: "asset_ref_1",
    });
  });

  it("asks for an upload when imaging is requested without a reference", () => {
    ensureAgentsRegistered();
    const plan = planAgentRunDeterministic("Generate an image of a calm workspace");
    expect(plan.kind).toBe("clarification");
    if (plan.kind !== "clarification") return;
    expect(plan.question).toMatch(/upload/i);
  });
});
