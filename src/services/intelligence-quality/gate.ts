/**
 * Phase 14F — quality gate from transparent dimensions + verification budget.
 * Critic / LLM notes never override this function.
 */

import type { OpportunityQualityGate, VerificationBudget } from "@prisma/client";
import { averageDimensions, type QualityDimensions } from "./dimensions";

export type GateInput = {
  dimensions: QualityDimensions;
  budget: VerificationBudget;
  contradictingCount: number;
  supportingCount: number;
};

/**
 * Budget-scaled thresholds. Not calibrated probabilities —
 * stricter budgets demand more independent support and fresher evidence.
 */
const THRESHOLDS: Record<
  VerificationBudget,
  { passAvg: number; minCorroboration: number; minFreshness: number; minSupport: number }
> = {
  FAST: { passAvg: 0.45, minCorroboration: 0.15, minFreshness: 0.2, minSupport: 1 },
  STANDARD: { passAvg: 0.55, minCorroboration: 0.4, minFreshness: 0.4, minSupport: 1 },
  DEEP: { passAvg: 0.65, minCorroboration: 0.75, minFreshness: 0.5, minSupport: 2 },
  MISSION_CRITICAL: { passAvg: 0.75, minCorroboration: 0.75, minFreshness: 0.65, minSupport: 2 },
};

export function budgetThresholds(budget: VerificationBudget) {
  return THRESHOLDS[budget];
}

export function applyQualityGate(input: GateInput): OpportunityQualityGate {
  const t = THRESHOLDS[input.budget];
  const d = input.dimensions;

  // Empty support always insufficient — evaluate before freshness so missing
  // evidence is not mislabelled STALE.
  if (input.supportingCount === 0) {
    return "INSUFFICIENT_EVIDENCE";
  }

  if (input.contradictingCount > 0 && input.contradictingCount >= input.supportingCount) {
    return "CONFLICTED";
  }
  if (d.negativeEvidence >= 0.5 && input.contradictingCount > 0) {
    return "CONFLICTED";
  }

  if (d.freshness < t.minFreshness) return "STALE";

  if (input.supportingCount < t.minSupport || d.corroboration < t.minCorroboration) {
    return "NEEDS_MORE_RESEARCH";
  }

  const avg = averageDimensions(d);
  if (avg < t.passAvg * 0.7) return "INSUFFICIENT_EVIDENCE";
  if (avg < t.passAvg) return "NEEDS_MORE_RESEARCH";

  if (d.survivorshipRisk >= 0.7 && input.budget !== "FAST") {
    return "NEEDS_MORE_RESEARCH";
  }

  return "PASSED";
}

/** High-priority opportunity ranking is only honest when the gate passed. */
export function gateAllowsHighPriorityOpportunity(gate: OpportunityQualityGate): boolean {
  return gate === "PASSED";
}
