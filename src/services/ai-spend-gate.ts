import { prisma } from "@/lib/db";
import { usdToCents } from "@/lib/ai-models";
import { logger } from "@/lib/logger";

export class SpendCapExceededError extends Error {
  readonly code = "SPEND_CAP_EXCEEDED";
  constructor(
    message: string,
    readonly organisationId: string,
    readonly spentCents: number,
    readonly capCents: number,
  ) {
    super(message);
    this.name = "SpendCapExceededError";
  }
}

function startOfUtcMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** Sum estimated AI spend for the organisation in the current UTC month (cents). */
export async function getOrganisationPeriodSpendCents(organisationId: string): Promise<number> {
  const periodStart = startOfUtcMonth();
  const agg = await prisma.aiExecution.aggregate({
    where: {
      organisationId,
      createdAt: { gte: periodStart },
      estimatedCost: { not: null },
    },
    _sum: { estimatedCost: true },
  });
  return usdToCents(agg._sum.estimatedCost ?? 0);
}

export async function getOrganisationAiBudget(organisationId: string) {
  return prisma.organisationAiBudget.findUnique({
    where: { organisationId },
  });
}

/**
 * Upsert per-org monthly AI spend cap (cents). null = unlimited.
 * Always org-scoped.
 */
export async function setOrganisationAiBudget(input: {
  organisationId: string;
  monthlyCapCents: number | null;
}) {
  return prisma.organisationAiBudget.upsert({
    where: { organisationId: input.organisationId },
    create: {
      organisationId: input.organisationId,
      monthlyCapCents: input.monthlyCapCents,
    },
    update: {
      monthlyCapCents: input.monthlyCapCents,
    },
  });
}

/**
 * PRE-DISPATCH spend gate. Rejects before any AI call when the org is over cap.
 * No cap configured → allow (preserves existing sales-path behaviour).
 */
export async function assertWithinSpendCap(
  organisationId: string,
  estimatedAdditionalCents = 0,
): Promise<{ ok: true; spentCents: number; capCents: number | null }> {
  const budget = await prisma.organisationAiBudget.findUnique({
    where: { organisationId },
  });
  const capCents = budget?.monthlyCapCents ?? null;
  if (capCents == null) {
    return { ok: true, spentCents: 0, capCents: null };
  }

  const spentCents = await getOrganisationPeriodSpendCents(organisationId);
  if (spentCents + estimatedAdditionalCents > capCents) {
    logger.warn("AI spend cap exceeded — blocking dispatch", {
      organisationId,
      spentCents,
      capCents,
      estimatedAdditionalCents,
    });
    throw new SpendCapExceededError(
      `Organisation AI spend cap exceeded for this period (${spentCents}¢ / ${capCents}¢)`,
      organisationId,
      spentCents,
      capCents,
    );
  }

  return { ok: true, spentCents, capCents };
}
