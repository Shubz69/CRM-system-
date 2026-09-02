/**
 * Central Claude / Anthropic model configuration.
 * Change models via env — do not hard-code model IDs in feature code.
 */

/** Formal tiers used by the multi-agent / structured-completion layer. */
export type FormalAiTier = "cheap" | "balanced" | "heavy";

/**
 * Legacy internal tier names (kept for router config + existing sales path).
 * Mapped 1:1 from FormalAiTier.
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
  // Canonical Anthropic defaults — override via ANTHROPIC_*_MODEL env / platform AI router.
  default: "claude-sonnet-4-6",
  economy: "claude-haiku-4-5-20251001",
  advanced: "claude-opus-4-5",
};

/**
 * Retired / legacy Anthropic model IDs that must never be sent to the API.
 * Mapped to the operational tier so call sites keep using central resolution.
 */
export const RETIRED_ANTHROPIC_MODELS: Record<string, AiModelTier> = {
  "claude-sonnet-4-20250514": "default",
  "claude-sonnet-4-5-20250929": "default",
  "claude-opus-4-20250514": "advanced",
  "claude-3-5-sonnet-latest": "default",
  "claude-3-5-sonnet-20241022": "default",
  "claude-3-5-haiku-latest": "economy",
  "claude-3-opus-20240229": "advanced",
};

export function isRetiredAnthropicModel(model?: string | null): boolean {
  if (!model) return false;
  return Boolean(RETIRED_ANTHROPIC_MODELS[model.trim()]);
}

/**
 * Resolve an operational Anthropic model ID.
 * - Env / platform defaults win for tiers
 * - Retired dated IDs remap to the current tier default (never sent to Anthropic)
 * - Does not invent a different provider
 */
export function resolveOperationalAnthropicModel(
  requested?: string | null,
  fallbackTier: AiModelTier = "default",
): string {
  const models = getAiModels();
  const trimmed = requested?.trim();
  if (!trimmed) return models[fallbackTier] || models.default;

  const retiredTier = RETIRED_ANTHROPIC_MODELS[trimmed];
  if (retiredTier) return models[retiredTier] || models.default;

  // Any other dated claude-* snapshot that isn't the active configured default → remap
  if (/^claude-/i.test(trimmed) && /-\d{8}$/.test(trimmed)) {
    const active = new Set(Object.values(models));
    if (!active.has(trimmed)) {
      return models[fallbackTier] || models.default;
    }
  }

  return trimmed;
}

/** Formal → legacy mapping. Every provider must implement all three formal tiers. */
export const FORMAL_TO_LEGACY_TIER: Record<FormalAiTier, AiModelTier> = {
  cheap: "economy",
  balanced: "default",
  heavy: "advanced",
};

export const LEGACY_TO_FORMAL_TIER: Record<AiModelTier, FormalAiTier> = {
  economy: "cheap",
  default: "balanced",
  advanced: "heavy",
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
    // Formal aliases
    cheap: process.env.ANTHROPIC_ECONOMY_MODEL || DEFAULT_MODELS.economy,
    balanced: process.env.ANTHROPIC_DEFAULT_MODEL || DEFAULT_MODELS.default,
    heavy: process.env.ANTHROPIC_ADVANCED_MODEL || DEFAULT_MODELS.advanced,
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

export function resolveModelForTier(tier: AiModelTier | FormalAiTier): string {
  const models = getAiModels();
  if (tier === "cheap" || tier === "balanced" || tier === "heavy") {
    return resolveOperationalAnthropicModel(models[tier] || models.balanced, "default");
  }
  return resolveOperationalAnthropicModel(models[tier] || models.default, tier);
}

/** True when an Anthropic HTTP error is a deterministic model/config failure (do not retry). */
export function isDeterministicAnthropicModelError(message: string): boolean {
  return (
    /\(404\)/.test(message) ||
    /model[_ ]?not[_ ]?found/i.test(message) ||
    /not_found_error/i.test(message) ||
    /invalid[_ ]?model/i.test(message) ||
    /\(400\).*(model|deprecated|retired)/i.test(message)
  );
}

export function toLegacyTier(tier: FormalAiTier | AiModelTier): AiModelTier {
  if (tier === "cheap" || tier === "balanced" || tier === "heavy") {
    return FORMAL_TO_LEGACY_TIER[tier];
  }
  return tier;
}

export function toFormalTier(tier: AiModelTier | FormalAiTier): FormalAiTier {
  if (tier === "cheap" || tier === "balanced" || tier === "heavy") return tier;
  return LEGACY_TO_FORMAL_TIER[tier];
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

/** Convert USD estimate to integer cents. */
export function usdToCents(usd: number): number {
  return Math.max(0, Math.round(usd * 100));
}

/**
 * Optional secondary/free-tier AI providers. Anthropic remains the only
 * provider every call site implicitly relies on (via resolveModelForTier
 * with no provider argument, which is untouched below). These are reached
 * only by an explicit getAiProvider(name) override or a global AI_PROVIDER
 * switch — never a silent default.
 */
export type OptionalAiProviderName = "openai" | "groq" | "mistral" | "deepseek" | "gemini";
export type AiProviderName = "anthropic" | "mock" | OptionalAiProviderName;

/**
 * Default model IDs per optional provider, per formal tier. Provider model
 * catalogs move fast — these are reasonable defaults as of when they were
 * added, always overridable via env (see below), and worth reviewing against
 * the provider's current docs before production lock-in (same convention as
 * the Apify actor defaults in apify-platforms.ts).
 */
const OPTIONAL_PROVIDER_DEFAULT_MODELS: Record<OptionalAiProviderName, Record<FormalAiTier, string>> = {
  openai: {
    cheap: "gpt-4o-mini",
    balanced: "gpt-4o-mini",
    heavy: "gpt-4o",
  },
  groq: {
    // Groq's free tier — fast Llama/Qwen inference, generous rate limits.
    cheap: "llama-3.1-8b-instant",
    balanced: "llama-3.3-70b-versatile",
    heavy: "meta-llama/llama-4-scout-17b-16e-instruct",
  },
  mistral: {
    // "-latest" aliases per Mistral's own API docs — track the current release automatically.
    cheap: "mistral-small-latest",
    balanced: "mistral-small-latest",
    heavy: "mistral-large-latest",
  },
  deepseek: {
    cheap: "deepseek-v4-flash",
    balanced: "deepseek-v4-flash",
    heavy: "deepseek-v4-pro",
  },
  gemini: {
    // Google AI Studio free tier (generous per-day quota on Flash/Flash-Lite).
    cheap: "gemini-3.1-flash-lite",
    balanced: "gemini-3.5-flash",
    heavy: "gemini-3.7-flash",
  },
};

const OPTIONAL_PROVIDER_ENV_PREFIX: Record<OptionalAiProviderName, string> = {
  openai: "OPENAI",
  groq: "GROQ",
  mistral: "MISTRAL",
  deepseek: "DEEPSEEK",
  gemini: "GEMINI_CHAT",
};

/**
 * Resolve the model for an explicitly-chosen optional provider + formal tier,
 * honouring env overrides (e.g. GROQ_ADVANCED_MODEL). Anthropic is not
 * handled here — use resolveModelForTier for the default/primary path.
 */
export function resolveModelForOptionalProvider(
  provider: OptionalAiProviderName,
  tier: FormalAiTier | AiModelTier,
): string {
  const formal = toFormalTier(tier);
  const prefix = OPTIONAL_PROVIDER_ENV_PREFIX[provider];
  const envKey = `${prefix}_${formal === "cheap" ? "ECONOMY" : formal === "heavy" ? "ADVANCED" : "DEFAULT"}_MODEL`;
  const override = process.env[envKey];
  if (override && override.trim()) return override.trim();
  return OPTIONAL_PROVIDER_DEFAULT_MODELS[provider][formal];
}
