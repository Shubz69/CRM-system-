import { prisma } from "@/lib/db";
import { estimateAnthropicCost } from "@/lib/ai-models";
import { recordUsage } from "@/services/usage";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";
import { getPlatformOrganisationId } from "@/lib/platform-org";

export async function recordAiExecution(input: {
  organisationId?: string | null;
  provider: string;
  model: string;
  taskType: string;
  feature?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  success: boolean;
  error?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const inputTokens = input.inputTokens ?? null;
  const outputTokens = input.outputTokens ?? null;
  const totalTokens =
    inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null;
  const estimatedCost =
    input.provider === "anthropic" && inputTokens != null && outputTokens != null
      ? estimateAnthropicCost(input.model, inputTokens, outputTokens)
      : null;

  const organisationId = input.organisationId || (await getPlatformOrganisationId());

  try {
    await prisma.aiExecution.create({
      data: {
        organisationId,
        provider: input.provider,
        model: input.model,
        taskType: input.taskType,
        feature: input.feature ?? null,
        inputTokens,
        outputTokens,
        totalTokens,
        latencyMs: input.latencyMs ?? null,
        success: input.success,
        error: input.error ?? null,
        estimatedCost,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    logger.warn("AiExecution write failed — falling back to UsageRecord", {
      message: error instanceof Error ? error.message : "unknown",
    });
  }

  await recordUsage({
    organisationId,
    feature: input.feature || `ai:${input.taskType}`,
    provider: input.provider,
    quantity: totalTokens || 1,
    metadata: {
      model: input.model,
      taskType: input.taskType,
      inputTokens,
      outputTokens,
      totalTokens,
      latencyMs: input.latencyMs,
      success: input.success,
      estimatedCost,
      ...(input.metadata || {}),
    },
  });
}
