import { afterEach, describe, expect, it, vi } from "vitest";
import { getAiProvider } from "@/adapters/ai";
import {
  DEFAULT_TASK_TIERS,
  getAiModels,
  getAiProviderDefaults,
  resolveModelForTier,
} from "@/lib/ai-models";
import { parseAiAnalysis, normalizeClaudeDecision } from "@/schemas/ai";
import { selectModelForTask } from "@/services/ai-router";
import { resetEnvCache } from "@/lib/env";

describe("Claude is primary AI", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("defaults provider to anthropic when AI_PROVIDER is unset", () => {
    vi.stubEnv("AI_PROVIDER", "");
    delete process.env.AI_PROVIDER;
    expect(getAiProviderDefaults().provider).toBe("anthropic");
  });

  it("resolves Claude model tiers from built-in defaults when model env is unset", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_MODEL", "");
    vi.stubEnv("ANTHROPIC_ECONOMY_MODEL", "");
    vi.stubEnv("ANTHROPIC_ADVANCED_MODEL", "");
    delete process.env.ANTHROPIC_DEFAULT_MODEL;
    delete process.env.ANTHROPIC_ECONOMY_MODEL;
    delete process.env.ANTHROPIC_ADVANCED_MODEL;

    const models = getAiModels();
    expect(models.default).toContain("claude");
    expect(models.economy).toContain("claude");
    expect(models.advanced).toContain("claude");
    expect(resolveModelForTier("economy")).toBe(models.economy);
  });

  it("routes classification to economy and high-value to advanced", () => {
    const router = {
      taskTiers: { ...DEFAULT_TASK_TIERS },
      escalateOnLowConfidence: true,
      lowConfidenceThreshold: 0.55,
      highValueScoreThreshold: 70,
    };
    expect(selectModelForTask({ taskType: "classification", router }).tier).toBe("economy");
    expect(selectModelForTask({ taskType: "conversation", router }).tier).toBe("default");
    expect(
      selectModelForTask({ taskType: "conversation", router, leadScore: 90 }).tier,
    ).toBe("advanced");
    expect(
      selectModelForTask({ taskType: "conversation", router, confidence: 0.2 }).tier,
    ).toBe("advanced");
  });

  it("operates without OPENAI_API_KEY", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    delete process.env.OPENAI_API_KEY;
    resetEnvCache();
    // Explicit anthropic request — never silently routes to OpenAI.
    const provider = getAiProvider("anthropic");
    expect(["anthropic", "mock", "not_configured"]).toContain(provider.name);
    expect(provider.name).not.toBe("openai");
  });

  it("parses Claude structured decision into rule-engine analysis", () => {
    const decision = {
      reply: "Thanks — happy to help with pricing on a quick call.",
      intent: { primary: "pricing", confidence: 0.9 },
      sentiment: { label: "positive" as const, confidence: 0.8 },
      crmUpdates: { company: "Dental Clinic", businessSize: "15 staff", need: "automate enquiries" },
      questions: [{ question: "How much does it cost?", category: "pricing" }],
      objections: [{ objection: "price concern", category: "price" }],
      qualification: {
        status: "qualifying" as const,
        fieldsUpdated: { company: "Dental Clinic" },
        missingFields: ["budget"],
        score: 62,
      },
      nextBestAction: { action: "ask_question" as const, reason: "Need budget" },
      booking: { sendLink: false },
      handoff: { required: false },
      knowledgeGap: { detected: false },
      confidence: 0.82,
      conversation_summary: "Lead asked about pricing for a dental practice.",
    };
    const normalized = normalizeClaudeDecision(decision as never);
    expect(normalized.intent).toBe("pricing");
    expect(normalized.reply).toContain("pricing");
    expect(normalized.questions_detected[0]).toContain("cost");

    const parsed = parseAiAnalysis(decision);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.format).toBe("claude_decision");
  });
});
