/**
 * Deterministic KPI calculators — never LLM.
 */

import { prisma } from "@/lib/db";
import { currencyOfUnit, moneyUnitFor } from "@/lib/customer-labels";
import { getDefaultDealCurrency, normaliseDealCurrency } from "@/services/crm-v2";

export type KpiCalculationResult = {
  value: number;
  unit: string;
  confidence: number;
  sourceReference: string;
  freshness: "FRESH" | "AGING" | "STALE" | "UNKNOWN";
  metadata?: Record<string, unknown>;
};

export type KpiCalculator = {
  key: string;
  /** For money calculators this is the default unit; a KPI can measure any <CURRENCY>_CENTS. */
  unit: string;
  description: string;
  /** `unit` is the KPI definition's unit — money calculators count deals in its currency. */
  calculate: (organisationId: string, options?: { unit?: string }) => Promise<KpiCalculationResult>;
};

/**
 * Revenue KPIs add up deals in ONE currency — the currency of the KPI's own unit (a £ target
 * counts £ deals, a $ target counts $ deals). Summing USD and GBP amounts into one figure was
 * wrong; deals in other currencies are reported per currency in the snapshot metadata instead
 * of being converted or mixed in. Without a unit, the workspace's main deal currency is used.
 */
async function sumDealsInCurrency(
  organisationId: string,
  status: "OPEN" | "WON",
  unit?: string,
): Promise<{
  currency: string;
  amountCents: number;
  count: number;
  excludedCurrencies: Array<{ currency: string; amountCents: number; count: number }>;
}> {
  const rows = await prisma.deal.groupBy({
    by: ["currency"],
    where: { organisationId, deletedAt: null, status },
    _sum: { amountCents: true },
    _count: { _all: true },
  });
  const currency = currencyOfUnit(unit) ?? (await getDefaultDealCurrency(organisationId));
  let amountCents = 0;
  let count = 0;
  const excluded = new Map<string, { currency: string; amountCents: number; count: number }>();
  for (const row of rows) {
    const rowCurrency = normaliseDealCurrency(row.currency) ?? "UNKNOWN";
    const sum = row._sum.amountCents ?? 0;
    const n = row._count._all;
    if (rowCurrency === currency) {
      amountCents += sum;
      count += n;
    } else {
      const entry = excluded.get(rowCurrency) ?? { currency: rowCurrency, amountCents: 0, count: 0 };
      entry.amountCents += sum;
      entry.count += n;
      excluded.set(rowCurrency, entry);
    }
  }
  return { currency, amountCents, count, excludedCurrencies: [...excluded.values()] };
}

async function openPipelineValueCents(
  organisationId: string,
  options?: { unit?: string },
): Promise<KpiCalculationResult> {
  const agg = await sumDealsInCurrency(organisationId, "OPEN", options?.unit);
  return {
    value: agg.amountCents,
    unit: moneyUnitFor(agg.currency),
    confidence: 1,
    sourceReference: `deal.open.sum:${agg.currency}:${agg.count}`,
    freshness: "FRESH",
    metadata: {
      openDealCount: agg.count,
      currency: agg.currency,
      excludedCurrencies: agg.excludedCurrencies,
    },
  };
}

async function wonRevenueCents(
  organisationId: string,
  options?: { unit?: string },
): Promise<KpiCalculationResult> {
  const agg = await sumDealsInCurrency(organisationId, "WON", options?.unit);
  return {
    value: agg.amountCents,
    unit: moneyUnitFor(agg.currency),
    confidence: 1,
    sourceReference: `deal.won.sum:${agg.currency}:${agg.count}`,
    freshness: "FRESH",
    metadata: {
      wonDealCount: agg.count,
      currency: agg.currency,
      excludedCurrencies: agg.excludedCurrencies,
    },
  };
}

async function qualifiedLeadCount(organisationId: string): Promise<KpiCalculationResult> {
  const count = await prisma.lead.count({
    where: {
      organisationId,
      deletedAt: null,
      OR: [{ score: { gte: 70 } }, { stage: { slug: "qualified" } }],
    },
  });
  return {
    value: count,
    unit: "COUNT",
    confidence: 0.9,
    sourceReference: `lead.qualified.count:${count}`,
    freshness: "FRESH",
  };
}

async function bookedMeetingCount(organisationId: string): Promise<KpiCalculationResult> {
  const count = await prisma.lead.count({
    where: {
      organisationId,
      deletedAt: null,
      stage: { slug: { in: ["booked", "booking_offered"] } },
    },
  });
  return {
    value: count,
    unit: "COUNT",
    confidence: 0.85,
    sourceReference: `lead.booked.count:${count}`,
    freshness: "FRESH",
  };
}

async function leadConversionRate(organisationId: string): Promise<KpiCalculationResult> {
  const [total, won] = await Promise.all([
    prisma.lead.count({ where: { organisationId, deletedAt: null } }),
    prisma.lead.count({
      where: { organisationId, deletedAt: null, stage: { isWon: true } },
    }),
  ]);
  const value = total === 0 ? 0 : won / total;
  return {
    value,
    unit: "RATE",
    confidence: total >= 10 ? 0.9 : 0.5,
    sourceReference: `lead.conversion:${won}/${total}`,
    freshness: "FRESH",
    metadata: { total, won },
  };
}

export const KPI_CALCULATORS: Record<string, KpiCalculator> = {
  open_pipeline_cents: {
    key: "open_pipeline_cents",
    unit: "GBP_CENTS",
    description: "Sum of open deal amounts in the KPI's currency (deals in other currencies are listed separately)",
    calculate: openPipelineValueCents,
  },
  won_revenue_cents: {
    key: "won_revenue_cents",
    unit: "GBP_CENTS",
    description: "Sum of won deal amounts in the KPI's currency (deals in other currencies are listed separately)",
    calculate: wonRevenueCents,
  },
  qualified_lead_count: {
    key: "qualified_lead_count",
    unit: "COUNT",
    description: "Leads with score≥70 or qualified stage",
    calculate: qualifiedLeadCount,
  },
  booked_meeting_count: {
    key: "booked_meeting_count",
    unit: "COUNT",
    description: "Leads in booked / booking_offered stages",
    calculate: bookedMeetingCount,
  },
  lead_conversion_rate: {
    key: "lead_conversion_rate",
    unit: "RATE",
    description: "Won leads / total leads",
    calculate: leadConversionRate,
  },
};

export function getKpiCalculator(key: string): KpiCalculator | null {
  return KPI_CALCULATORS[key] ?? null;
}
