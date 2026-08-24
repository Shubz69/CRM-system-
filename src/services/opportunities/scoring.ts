/**
 * Opportunity status transitions + deterministic scoring.
 * Confidence / impact / urgency are bands — never fake float precision.
 */

import type {
  BusinessOpportunityStatus,
  OpportunityConfidenceBand,
  OpportunityImpactBand,
  OpportunityUrgencyBand,
} from "@prisma/client";

export class InvalidOpportunityTransitionError extends Error {
  readonly code = "INVALID_OPPORTUNITY_TRANSITION";
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid BusinessOpportunity transition ${from} → ${to}`);
    this.name = "InvalidOpportunityTransitionError";
  }
}

const TRANSITIONS: Record<BusinessOpportunityStatus, readonly BusinessOpportunityStatus[]> = {
  DETECTED: ["REVIEWED", "ACCEPTED", "REJECTED", "DISMISSED", "EXPIRED"],
  REVIEWED: ["ACCEPTED", "REJECTED", "DISMISSED", "EXPIRED"],
  ACCEPTED: ["PLANNED", "IN_PROGRESS", "REJECTED", "DISMISSED", "EXPIRED"],
  PLANNED: ["IN_PROGRESS", "DISMISSED", "EXPIRED"],
  IN_PROGRESS: ["COMPLETED", "DISMISSED", "EXPIRED"],
  REJECTED: [],
  COMPLETED: [],
  EXPIRED: [],
  DISMISSED: [],
};

export function assertOpportunityTransition(
  from: BusinessOpportunityStatus,
  to: BusinessOpportunityStatus,
): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidOpportunityTransitionError(from, to);
  }
}

const CONFIDENCE_W: Record<OpportunityConfidenceBand, number> = {
  LOW: 0.45,
  MEDIUM: 0.7,
  HIGH: 0.95,
};
const IMPACT_W: Record<OpportunityImpactBand, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3.5,
  VERY_HIGH: 5,
};
const URGENCY_W: Record<OpportunityUrgencyBand, number> = {
  LOW: 1,
  MEDIUM: 1.5,
  HIGH: 2.5,
  CRITICAL: 4,
};

/**
 * Priority = impact × urgency × confidence × goalAlignment ÷ effortFactor
 * Documented deterministic model — LLM may explain, not invent.
 */
export function computePriorityScore(input: {
  impact: OpportunityImpactBand;
  urgency: OpportunityUrgencyBand;
  confidence: OpportunityConfidenceBand;
  goalAlignment?: number; // 0.5–1.5, default 1 when no goal
  effortFactor?: number; // 1–3, default 1
}): { score: number; factors: Record<string, number> } {
  const goalAlignment = Math.min(1.5, Math.max(0.5, input.goalAlignment ?? 1));
  const effortFactor = Math.min(3, Math.max(1, input.effortFactor ?? 1));
  const factors = {
    impact: IMPACT_W[input.impact],
    urgency: URGENCY_W[input.urgency],
    confidence: CONFIDENCE_W[input.confidence],
    goalAlignment,
    effortFactor,
  };
  const score =
    (factors.impact * factors.urgency * factors.confidence * factors.goalAlignment) /
    factors.effortFactor;
  return { score: Math.round(score * 1000) / 1000, factors };
}

export function deriveConfidence(input: {
  independentSignals: number;
  dataFresh: boolean;
  sourceQuality: "low" | "medium" | "high";
}): OpportunityConfidenceBand {
  let points = 0;
  points += Math.min(3, input.independentSignals);
  if (input.dataFresh) points += 1;
  if (input.sourceQuality === "high") points += 2;
  else if (input.sourceQuality === "medium") points += 1;
  if (points >= 5) return "HIGH";
  if (points >= 3) return "MEDIUM";
  return "LOW";
}

export function deriveImpact(input: {
  dealValueCents?: number | null;
  goalPriority?: number | null;
  kpiGapRatio?: number | null;
}): OpportunityImpactBand {
  if (input.dealValueCents != null && input.dealValueCents >= 100_000_00) return "VERY_HIGH";
  if (input.dealValueCents != null && input.dealValueCents >= 25_000_00) return "HIGH";
  if (input.kpiGapRatio != null && input.kpiGapRatio >= 0.5) return "HIGH";
  if (input.goalPriority != null && input.goalPriority <= 50) return "HIGH";
  if (input.dealValueCents != null && input.dealValueCents >= 5_000_00) return "MEDIUM";
  if (input.kpiGapRatio != null && input.kpiGapRatio >= 0.2) return "MEDIUM";
  return "LOW";
}

export function deriveUrgency(input: {
  daysInactive?: number;
  daysToDeadline?: number | null;
  expiredSoon?: boolean;
}): OpportunityUrgencyBand {
  if (input.expiredSoon) return "CRITICAL";
  if (input.daysToDeadline != null && input.daysToDeadline <= 7) return "CRITICAL";
  if (input.daysToDeadline != null && input.daysToDeadline <= 21) return "HIGH";
  if ((input.daysInactive ?? 0) >= 21) return "HIGH";
  if ((input.daysInactive ?? 0) >= 7) return "MEDIUM";
  return "LOW";
}
