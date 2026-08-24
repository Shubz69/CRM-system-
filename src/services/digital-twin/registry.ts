/**
 * Controlled entity types & relationship types for the Digital Twin.
 * Strongly typed domain tables remain primary — this is the cross-domain registry.
 */

export const TWIN_ENTITY_TYPES = [
  "Organisation",
  "Company",
  "Contact",
  "Competitor",
  "Creator",
  "ProductOffering",
  "AudienceSegment",
  "Topic",
  "Campaign",
  "ContentPiece",
  "Lead",
  "Deal",
  "Goal",
  "KpiDefinition",
  "Initiative",
  "BusinessOpportunity",
  "TrendCluster",
] as const;

export type TwinEntityType = (typeof TWIN_ENTITY_TYPES)[number];

export const TWIN_RELATIONSHIP_TYPES = [
  "COMPETES_WITH",
  "INTERESTED_IN",
  "WORKS_AT",
  "TARGETS",
  "DISCUSSES",
  "RELATED_TO",
  "PUBLISHES",
  "SUPPORTS",
  "OFFERS",
  "SERVES",
] as const;

export type TwinRelationshipType = (typeof TWIN_RELATIONSHIP_TYPES)[number];

export function isTwinEntityType(v: string): v is TwinEntityType {
  return (TWIN_ENTITY_TYPES as readonly string[]).includes(v);
}

export function isTwinRelationshipType(v: string): v is TwinRelationshipType {
  return (TWIN_RELATIONSHIP_TYPES as readonly string[]).includes(v);
}

/** Freshness policy by data class (days until AGING / STALE). */
export const FRESHNESS_POLICY: Record<
  string,
  { agingDays: number; staleDays: number }
> = {
  company_description: { agingDays: 90, staleDays: 180 },
  competitor_pricing: { agingDays: 14, staleDays: 45 },
  trend: { agingDays: 3, staleDays: 14 },
  social_metrics: { agingDays: 1, staleDays: 7 },
  goal: { agingDays: 30, staleDays: 90 },
  kpi_daily: { agingDays: 2, staleDays: 7 },
  kpi_weekly: { agingDays: 10, staleDays: 21 },
  default: { agingDays: 14, staleDays: 60 },
};

export type FreshnessBand = "FRESH" | "AGING" | "STALE" | "UNKNOWN";

export function classifyFreshness(
  lastAt: Date | null | undefined,
  policyKey = "default",
): FreshnessBand {
  if (!lastAt) return "UNKNOWN";
  const policy = FRESHNESS_POLICY[policyKey] ?? FRESHNESS_POLICY.default;
  const ageDays = (Date.now() - lastAt.getTime()) / (24 * 60 * 60_000);
  if (ageDays <= policy.agingDays) return "FRESH";
  if (ageDays <= policy.staleDays) return "AGING";
  return "STALE";
}
