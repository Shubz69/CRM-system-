/**
 * Deterministic KPI calculators — never LLM.
 */

import { prisma } from "@/lib/db";

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
  unit: string;
  description: string;
  calculate: (organisationId: string) => Promise<KpiCalculationResult>;
};

async function openPipelineValueCents(organisationId: string): Promise<KpiCalculationResult> {
  const agg = await prisma.deal.aggregate({
    where: { organisationId, deletedAt: null, status: "OPEN" },
    _sum: { amountCents: true },
    _count: true,
  });
  return {
    value: agg._sum.amountCents ?? 0,
    unit: "GBP_CENTS",
    confidence: 1,
    sourceReference: `deal.open.sum:${agg._count}`,
    freshness: "FRESH",
    metadata: { openDealCount: agg._count },
  };
}

async function wonRevenueCents(organisationId: string): Promise<KpiCalculationResult> {
  const agg = await prisma.deal.aggregate({
    where: { organisationId, deletedAt: null, status: "WON" },
    _sum: { amountCents: true },
    _count: true,
  });
  return {
    value: agg._sum.amountCents ?? 0,
    unit: "GBP_CENTS",
    confidence: 1,
    sourceReference: `deal.won.sum:${agg._count}`,
    freshness: "FRESH",
    metadata: { wonDealCount: agg._count },
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
    description: "Sum of open Deal.amountCents",
    calculate: openPipelineValueCents,
  },
  won_revenue_cents: {
    key: "won_revenue_cents",
    unit: "GBP_CENTS",
    description: "Sum of won Deal.amountCents",
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
