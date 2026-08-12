import { prisma } from "@/lib/db";
import {
  DEFAULT_TASK_TIERS,
  getAiProviderDefaults,
  resolveModelForTier,
  type AiModelTier,
  type AiTaskType,
} from "@/lib/ai-models";
import { getAiProvider } from "@/adapters/ai";
import { recordAiExecution } from "@/services/ai-execution";
import { logger } from "@/lib/logger";
import type { AiProvider } from "@/adapters/ai/types";
import { assertWithinSpendCap, SpendCapExceededError } from "@/services/ai-spend-gate";

export type RouterConfig = {
  taskTiers: Partial<Record<AiTaskType, AiModelTier>>;
  escalateOnLowConfidence: boolean;
  lowConfidenceThreshold: number;
  highValueScoreThreshold: number;
};

const DEFAULT_ROUTER: RouterConfig = {
  taskTiers: { ...DEFAULT_TASK_TIERS },
  escalateOnLowConfidence: true,
  lowConfidenceThreshold: 0.55,
  highValueScoreThreshold: 70,
};

export async function getAiRouterConfig(): Promise<RouterConfig> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: "ai.router" } });
    if (!row?.value || typeof row.value !== "object") return DEFAULT_ROUTER;
    const value = row.value as Record<string, unknown>;
    return {
      taskTiers: {
        ...DEFAULT_TASK_TIERS,
        ...((value.taskTiers as Partial<Record<AiTaskType, AiModelTier>>) || {}),
      },
      escalateOnLowConfidence:
        typeof value.escalateOnLowConfidence === "boolean"
          ? value.escalateOnLowConfidence
          : DEFAULT_ROUTER.escalateOnLowConfidence,
      lowConfidenceThreshold:
        typeof value.lowConfidenceThreshold === "number"
          ? value.lowConfidenceThreshold
          : DEFAULT_ROUTER.lowConfidenceThreshold,
      highValueScoreThreshold:
        typeof value.highValueScoreThreshold === "number"
          ? value.highValueScoreThreshold
          : DEFAULT_ROUTER.highValueScoreThreshold,
    };
  } catch {
    return DEFAULT_ROUTER;
  }
}

export async function saveAiRouterConfig(config: Partial<RouterConfig>) {
  const current = await getAiRouterConfig();
  const next: RouterConfig = {
    taskTiers: { ...current.taskTiers, ...(config.taskTiers || {}) },
    escalateOnLowConfidence:
      config.escalateOnLowConfidence ?? current.escalateOnLowConfidence,
    lowConfidenceThreshold:
      config.lowConfidenceThreshold ?? current.lowConfidenceThreshold,
    highValueScoreThreshold:
      config.highValueScoreThreshold ?? current.highValueScoreThreshold,
  };
  await prisma.systemSetting.upsert({
    where: { key: "ai.router" },
    create: { key: "ai.router", value: next },
    update: { value: next },
  });
  return next;
}

export function selectModelForTask(input: {
  taskType: AiTaskType;
  router: RouterConfig;
  escalate?: boolean;
  leadScore?: number;
  confidence?: number;
  modelOverride?: string;
}): { tier: AiModelTier; model: string; reason: string } {
  if (input.modelOverride) {
    return { tier: "default", model: input.modelOverride, reason: "explicit_override" };
  }

  let tier: AiModelTier = input.router.taskTiers[input.taskType] || DEFAULT_TASK_TIERS[input.taskType] || "default";
  let reason = `task:${input.taskType}`;

  if (input.escalate) {
    tier = "advanced";
    reason = "explicit_escalate";
  } else if (
    input.router.escalateOnLowConfidence &&
    typeof input.confidence === "number" &&
    input.confidence < input.router.lowConfidenceThreshold
  ) {
    tier = "advanced";
    reason = "low_confidence";
  } else if (
    typeof input.leadScore === "number" &&
    input.leadScore >= input.router.highValueScoreThreshold
  ) {
    tier = "advanced";
    reason = "high_value_lead";
  }

  return { tier, model: resolveModelForTier(tier), reason };
}

export function resolveConversationProvider(agentProvider?: string | null): AiProvider {
  const defaults = getAiProviderDefaults();
  // Prefer Anthropic: ignore stale "openai" workspace defaults when no OPENAI key
  let preferred = (agentProvider || defaults.provider || "anthropic").toLowerCase();
  if (preferred === "openai" && !process.env.OPENAI_API_KEY) {
    preferred = "anthropic";
  }
  if (preferred === "mock" && process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") {
    preferred = "anthropic";
  }
  return getAiProvider(preferred);
}

export async function routeAndAnalyse(input: {
  organisationId: string;
  taskType?: AiTaskType;
  agentProvider?: string | null;
  modelOverride?: string | null;
  leadScore?: number;
  escalate?: boolean;
  systemPrompt: string;
  conversationTranscript: string;
  knowledgeContext: string;
  leadMessage: string;
  crmMemory?: unknown;
}) {
  const router = await getAiRouterConfig();
  const taskType = input.taskType || "conversation";
  const selection = selectModelForTask({
    taskType,
    router,
    escalate: input.escalate,
    leadScore: input.leadScore,
    modelOverride: input.modelOverride || undefined,
  });

  const provider = resolveConversationProvider(input.agentProvider);
  const started = Date.now();

  // Inject CRM memory into knowledge context so Claude does not re-ask known facts
  const memoryBlock =
    input.crmMemory && typeof input.crmMemory === "object"
      ? `\n\nKnown CRM memory (do not re-ask confirmed fields):\n${JSON.stringify(input.crmMemory, null, 2)}`
      : "";

  try {
    const { analyseWithValidation, AnthropicProvider } = await import("@/adapters/ai");

    try {
      await assertWithinSpendCap(input.organisationId);
    } catch (error) {
      if (error instanceof SpendCapExceededError) {
        await recordAiExecution({
          organisationId: input.organisationId,
          provider: provider.name,
          model: selection.model,
          taskType,
          feature: "inbound_conversation",
          latencyMs: Date.now() - started,
          success: false,
          error: error.message,
          metadata: { blockedBy: "spend_cap" },
        });
        return {
          result: { ok: false as const, reason: error.message },
          provider: provider.name,
          model: selection.model,
          tier: selection.tier,
          taskType,
          latencyMs: Date.now() - started,
        };
      }
      throw error;
    }

    const result = await analyseWithValidation(provider, {
      model: selection.model,
      systemPrompt: input.systemPrompt,
      conversationTranscript: input.conversationTranscript,
      knowledgeContext: `${input.knowledgeContext || "(none)"}${memoryBlock}`,
      leadMessage: input.leadMessage,
    });

    const latencyMs = Date.now() - started;
    const success = result.ok;
    const confidence = result.ok ? result.analysis.confidence : undefined;
    const usage =
      provider instanceof AnthropicProvider
        ? provider.lastUsage
        : ({} as { inputTokens?: number; outputTokens?: number });

    // Second-pass escalation if confidence is low and we didn't already use advanced
    if (
      result.ok &&
      selection.tier !== "advanced" &&
      router.escalateOnLowConfidence &&
      confidence !== undefined &&
      confidence < router.lowConfidenceThreshold
    ) {
      const advanced = selectModelForTask({
        taskType: "high_value_reasoning",
        router,
        escalate: true,
      });
      const repaired = await analyseWithValidation(provider, {
        model: advanced.model,
        systemPrompt: input.systemPrompt,
        conversationTranscript: input.conversationTranscript,
        knowledgeContext: `${input.knowledgeContext || "(none)"}${memoryBlock}`,
        leadMessage: input.leadMessage,
      });
      const escalatedLatency = Date.now() - started;
      const escUsage =
        provider instanceof AnthropicProvider
          ? provider.lastUsage
          : ({} as { inputTokens?: number; outputTokens?: number });
      await recordAiExecution({
        organisationId: input.organisationId,
        provider: provider.name,
        model: advanced.model,
        taskType: "high_value_reasoning",
        feature: "inbound_conversation",
        inputTokens: escUsage.inputTokens,
        outputTokens: escUsage.outputTokens,
        latencyMs: escalatedLatency,
        success: repaired.ok,
        error: repaired.ok ? null : repaired.reason,
        metadata: {
          escalatedFrom: selection.model,
          reason: "low_confidence",
          repaired: repaired.ok ? repaired.repaired : false,
        },
      });
      return {
        result: repaired,
        provider: provider.name,
        model: advanced.model,
        tier: advanced.tier as AiModelTier,
        taskType: "high_value_reasoning" as AiTaskType,
        latencyMs: escalatedLatency,
      };
    }

    await recordAiExecution({
      organisationId: input.organisationId,
      provider: provider.name,
      model: selection.model,
      taskType,
      feature: "inbound_conversation",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs,
      success,
      error: success ? null : result.ok ? null : result.reason,
      metadata: {
        tier: selection.tier,
        reason: selection.reason,
        repaired: result.ok ? result.repaired : false,
      },
    });

    return {
      result,
      provider: provider.name,
      model: selection.model,
      tier: selection.tier,
      taskType,
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? error.message : "AI router error";
    logger.error("AI router failed", { message, model: selection.model });
    await recordAiExecution({
      organisationId: input.organisationId,
      provider: provider.name,
      model: selection.model,
      taskType,
      feature: "inbound_conversation",
      latencyMs,
      success: false,
      error: message,
    });
    throw error;
  }
}
