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

export type SpendBreakdownRow = {
  provider: string;
  model: string;
  taskType: string;
  /** Sum of estimatedCost in USD from AiExecution — null costs omitted. */
  estimatedCostUsd: number;
  estimatedCostCents: number;
  executionCount: number;
};

/**
 * Provider/model/taskType rollup for the current UTC month.
 * Only rows with non-null estimatedCost contribute — never invent rates.
 */
export async function getOrganisationSpendBreakdown(
  organisationId: string,
): Promise<{
  periodStart: Date;
  rows: SpendBreakdownRow[];
  totalCents: number;
  omittedNullCostCount: number;
  message: string;
}> {
  const periodStart = startOfUtcMonth();
  const [grouped, nullCostCount] = await Promise.all([
    prisma.aiExecution.groupBy({
      by: ["provider", "model", "taskType"],
      where: {
        organisationId,
        createdAt: { gte: periodStart },
        estimatedCost: { not: null },
      },
      _sum: { estimatedCost: true },
      _count: { _all: true },
    }),
    prisma.aiExecution.count({
      where: {
        organisationId,
        createdAt: { gte: periodStart },
        estimatedCost: null,
      },
    }),
  ]);

  const rows: SpendBreakdownRow[] = grouped
    .map((g) => {
      const usd = g._sum.estimatedCost ?? 0;
      return {
        provider: g.provider,
        model: g.model,
        taskType: g.taskType,
        estimatedCostUsd: usd,
        estimatedCostCents: usdToCents(usd),
        executionCount: g._count._all,
      };
    })
    .sort((a, b) => b.estimatedCostCents - a.estimatedCostCents);

  const totalCents = rows.reduce((sum, r) => sum + r.estimatedCostCents, 0);

  return {
    periodStart,
    rows,
    totalCents,
    omittedNullCostCount: nullCostCount,
    message:
      rows.length === 0
        ? "No AiExecution rows with estimatedCost this UTC month — breakdown hidden."
        : `Ledger rollup from ${rows.reduce((n, r) => n + r.executionCount, 0)} priced execution(s)` +
          (nullCostCount > 0 ? `; ${nullCostCount} row(s) omitted (null estimatedCost).` : "."),
  };
}
