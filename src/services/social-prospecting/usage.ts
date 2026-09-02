import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export async function recordSocialProviderUsage(input: {
  organisationId: string;
  provider: string;
  capability: string;
  network?: string;
  requestCount?: number;
  costCents?: number | null;
  latencyMs?: number;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.socialProviderUsage.create({
    data: {
      organisationId: input.organisationId,
      provider: input.provider,
      capability: input.capability,
      network: input.network,
      requestCount: input.requestCount ?? 1,
      costCents: input.costCents ?? null,
      latencyMs: input.latencyMs,
      errorCode: input.errorCode,
      metadata: (input.metadata || {}) as Prisma.InputJsonValue,
    },
  });
}
