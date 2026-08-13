import { Prisma } from "@prisma/client";
import type { SourcePlatform } from "@/adapters/sources/types";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordUsage } from "@/services/usage";

/**
 * Record Apify spend so the monthly spend gate sees it (AiExecution.estimatedCost)
 * and usage admin can attribute it. Actor IDs stay in metadata for ops only.
 */
export async function recordApifySpend(input: {
  organisationId: string;
  platform: SourcePlatform;
  costCents: number;
  success: boolean;
  latencyMs?: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const costCents = Math.max(0, Math.round(input.costCents));
  const estimatedCost = costCents / 100;

  try {
    await prisma.aiExecution.create({
      data: {
        organisationId: input.organisationId,
        provider: "apify",
        model: `source:${input.platform}`,
        taskType: "source_search",
        feature: `source:${input.platform}`,
        latencyMs: input.latencyMs ?? null,
        success: input.success,
        error: input.error ?? null,
        estimatedCost: costCents > 0 ? estimatedCost : null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    logger.warn("Apify AiExecution write failed — falling back to UsageRecord", {
      organisationId: input.organisationId,
      platform: input.platform,
      message: error instanceof Error ? error.message : "unknown",
    });
  }

  await recordUsage({
    organisationId: input.organisationId,
    feature: `source:${input.platform}`,
    provider: "apify",
    quantity: 1,
    metadata: {
      costCents,
      estimatedCost,
      success: input.success,
      ...(input.metadata || {}),
    },
  });
}

/** Mutable sink so adapters can report billable cents without changing SourceAdapter. */
export type BillableCentsSink = { value: number };

export function addBillableCents(sink: BillableCentsSink | undefined, cents: number): void {
  if (!sink) return;
  sink.value += Math.max(0, Math.round(cents));
}
