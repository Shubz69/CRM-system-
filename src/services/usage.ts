import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";
import { getPlatformOrganisationId } from "@/lib/platform-org";

export async function recordUsage(input: {
  organisationId?: string | null;
  feature: string;
  provider?: string | null;
  quantity?: number;
  metadata?: Record<string, unknown>;
}) {
  try {
    const organisationId = input.organisationId || (await getPlatformOrganisationId());
    await prisma.usageRecord.create({
      data: {
        organisationId,
        feature: input.feature,
        provider: input.provider ?? null,
        quantity: input.quantity ?? 1,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    logger.warn("Failed to record usage", {
      feature: input.feature,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}
