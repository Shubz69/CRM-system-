/**
 * Central Claude / Anthropic model configuration.
 * Change models via env — do not hard-code model IDs in feature code.
 */

export type AiModelTier = "default" | "economy" | "advanced";

export type AiTaskType =
  | "conversation"
  | "classification"
  | "crm_extraction"
  | "qualification"
  | "lead_scoring"
  | "next_best_action"
  | "knowledge_answer"
  | "summary"
  | "insight_generation"
  | "content_generation"
  | "high_value_reasoning"
  | "setup_assistant"
  | "repair"
  | "objection_handling"
  | "sentiment";

const DEFAULT_MODELS: Record<AiModelTier, string> = {
  default: "claude-sonnet-4-20250514",
  economy: "claude-3-5-haiku-latest",
  advanced: "claude-opus-4-20250514",
};

/** Default task → tier mapping (overridable via SystemSetting ai.router) */
export const DEFAULT_TASK_TIERS: Record<AiTaskType, AiModelTier> = {
  conversation: "default",
  classification: "economy",
  crm_extraction: "default",
  qualification: "default",
  lead_scoring: "economy",
  next_best_action: "default",
  knowledge_answer: "default",
  summary: "economy",
  insight_generation: "default",
  content_generation: "default",
  high_value_reasoning: "advanced",
  setup_assistant: "default",
  repair: "default",
  objection_handling: "default",
  sentiment: "economy",
};

export function getAiModels() {
  return {
    default: process.env.ANTHROPIC_DEFAULT_MODEL || DEFAULT_MODELS.default,
    economy: process.env.ANTHROPIC_ECONOMY_MODEL || DEFAULT_MODELS.economy,
    advanced: process.env.ANTHROPIC_ADVANCED_MODEL || DEFAULT_MODELS.advanced,
  } as const;
}

export function getAiProviderDefaults() {
  const raw = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
  const provider =
    raw === "openai" || raw === "anthropic" || raw === "mock" ? raw : "anthropic";
  return {
    provider,
    models: getAiModels(),
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 2048),
    timeoutMs: Number(process.env.ANTHROPIC_TIMEOUT_MS || 45_000),
    retries: Number(process.env.ANTHROPIC_RETRIES || 1),
    temperature: Number(process.env.ANTHROPIC_TEMPERATURE || 0.2),
  };
}

export function resolveModelForTier(tier: AiModelTier): string {
  const models = getAiModels();
  return models[tier] || models.default;
}

/** Indicative USD per 1M tokens for cost estimates (configurable later). */
export function estimateAnthropicCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const m = model.toLowerCase();
  let inPerM = 3;
  let outPerM = 15;
  if (m.includes("haiku")) {
    inPerM = 0.8;
    outPerM = 4;
  } else if (m.includes("opus")) {
    inPerM = 15;
    outPerM = 75;
  } else if (m.includes("sonnet")) {
    inPerM = 3;
    outPerM = 15;
  }
  return Math.round(((inputTokens * inPerM + outputTokens * outPerM) / 1_000_000) * 10_000) / 10_000;
}
