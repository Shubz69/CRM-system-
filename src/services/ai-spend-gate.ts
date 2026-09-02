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

  /** Customer-safe message — never exposes vendor pricing. */
  toCustomerMessage(): string {
    return "This workspace has reached its Agent Desk intelligence usage limit for this period. CRM data is preserved — try again next period or contact your administrator.";
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
/** Safe default for new beta / tester workspaces ($25 / month). */
export const BETA_ORG_AI_MONTHLY_CAP_CENTS = 2_500;

/** Warning fires at this fraction of the monthly hard cap (no schema change). */
export const AI_BUDGET_WARNING_RATIO = 0.8;

export const CUSTOMER_AI_ALLOWANCE_EXCEEDED =
  "You've reached this workspace's AI allowance for the month. It resets next month, or an admin can raise it.";

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

/** Idempotent beta default — does not overwrite an existing budget row. */
export async function ensureBetaOrganisationAiBudget(
  organisationId: string,
  monthlyCapCents: number = BETA_ORG_AI_MONTHLY_CAP_CENTS,
) {
  const existing = await prisma.organisationAiBudget.findUnique({
    where: { organisationId },
  });
  if (existing) return existing;
  return setOrganisationAiBudget({ organisationId, monthlyCapCents });
}

export type OrganisationAiBudgetStatus = {
  organisationId: string;
  spentCents: number;
  capCents: number | null;
  warningThresholdCents: number | null;
  warning: boolean;
  limited: boolean;
  /** Platform / diagnostics — real numbers. */
  diagnosticReason: string | null;
  /** Customer-safe message when limited; null otherwise. */
  customerMessage: string | null;
};

export async function getOrganisationAiBudgetStatus(
  organisationId: string,
): Promise<OrganisationAiBudgetStatus> {
  const budget = await getOrganisationAiBudget(organisationId);
  const capCents = budget?.monthlyCapCents ?? null;
  if (capCents == null) {
    return {
      organisationId,
      spentCents: 0,
      capCents: null,
      warningThresholdCents: null,
      warning: false,
      limited: false,
      diagnosticReason: null,
      customerMessage: null,
    };
  }
  const spentCents = await getOrganisationPeriodSpendCents(organisationId);
  let warningThresholdCents = Math.floor(capCents * AI_BUDGET_WARNING_RATIO);
  try {
    const { getAiBudgetWarningThresholdCents } = await import("@/services/beta-workspace");
    const preferred = await getAiBudgetWarningThresholdCents(organisationId);
    if (preferred != null) warningThresholdCents = preferred;
  } catch {
    /* preference lookup optional */
  }
  const limited = spentCents >= capCents;
  const warning = !limited && spentCents >= warningThresholdCents;
  return {
    organisationId,
    spentCents,
    capCents,
    warningThresholdCents,
    warning,
    limited,
    diagnosticReason: limited
      ? `SPEND_CAP_EXCEEDED: ${spentCents}¢ / ${capCents}¢ this UTC month`
      : warning
        ? `SPEND_WARNING: ${spentCents}¢ / ${capCents}¢ (threshold ${warningThresholdCents}¢)`
        : null,
    customerMessage: limited ? CUSTOMER_AI_ALLOWANCE_EXCEEDED : null,
  };
}

/**
 * PRE-DISPATCH spend gate. Rejects before any AI call when the org is over cap.
 * No cap configured → allow (preserves existing sales-path behaviour).
 */
export async function assertWithinSpendCap(
  organisationId: string,
  estimatedAdditionalCents = 0,
): Promise<{ ok: true; spentCents: number; capCents: number | null; warning: boolean }> {
  const budget = await prisma.organisationAiBudget.findUnique({
    where: { organisationId },
  });
  const capCents = budget?.monthlyCapCents ?? null;
  if (capCents == null) {
    return { ok: true, spentCents: 0, capCents: null, warning: false };
  }

  const spentCents = await getOrganisationPeriodSpendCents(organisationId);
  const warning =
    spentCents + estimatedAdditionalCents >= Math.floor(capCents * AI_BUDGET_WARNING_RATIO) &&
    spentCents + estimatedAdditionalCents <= capCents;

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

  return { ok: true, spentCents, capCents, warning };
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
