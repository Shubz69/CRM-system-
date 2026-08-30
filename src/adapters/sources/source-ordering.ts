/**
 * Cheapest-sufficient source ordering.
 * Stop when evidence is sufficient — do not fan out every tier by default.
 */

export type SourceCostTier =
  | "verified_evidence"
  | "persistent_cache"
  | "business_profile_knowledge_crm"
  | "official_api"
  | "tavily_http"
  | "apify_approved_low_cost"
  | "browser_proxy_actor";

/** Cheapest → most expensive. Browser/proxy Actors only if required. */
export const SOURCE_COST_TIER_ORDER: readonly SourceCostTier[] = [
  "verified_evidence",
  "persistent_cache",
  "business_profile_knowledge_crm",
  "official_api",
  "tavily_http",
  "apify_approved_low_cost",
  "browser_proxy_actor",
] as const;

export type SourceEvidenceBundle = {
  items: unknown[];
  notes?: string[];
};

export type SourceTierFetcher = {
  tier: SourceCostTier;
  /** Skip expensive tiers that are not applicable for this request. */
  enabled?: boolean;
  fetch: () => Promise<SourceEvidenceBundle>;
};

export function isEvidenceSufficient(
  evidence: SourceEvidenceBundle,
  minItems = 1,
): boolean {
  return evidence.items.length >= minItems;
}

export function mergeEvidence(
  a: SourceEvidenceBundle,
  b: SourceEvidenceBundle,
): SourceEvidenceBundle {
  return {
    items: [...a.items, ...b.items],
    notes: [...(a.notes || []), ...(b.notes || [])],
  };
}

/**
 * Walk tiers in cheapest-sufficient order. Stop as soon as `isSufficient` passes.
 * Does not fork Quality Engine / compute governor — callers supply sufficiency.
 */
export async function collectCheapestSufficientSources(input: {
  tiers: SourceTierFetcher[];
  isSufficient?: (evidence: SourceEvidenceBundle) => boolean;
  minItems?: number;
}): Promise<{
  evidence: SourceEvidenceBundle;
  stoppedAt: SourceCostTier | null;
  tiersTried: SourceCostTier[];
  sufficient: boolean;
}> {
  const order = new Map(SOURCE_COST_TIER_ORDER.map((t, i) => [t, i]));
  const sorted = [...input.tiers].sort(
    (a, b) => (order.get(a.tier) ?? 99) - (order.get(b.tier) ?? 99),
  );

  const check =
    input.isSufficient ??
    ((evidence: SourceEvidenceBundle) => isEvidenceSufficient(evidence, input.minItems ?? 1));

  let evidence: SourceEvidenceBundle = { items: [], notes: [] };
  const tiersTried: SourceCostTier[] = [];
  let stoppedAt: SourceCostTier | null = null;

  for (const tier of sorted) {
    if (tier.enabled === false) continue;
    tiersTried.push(tier.tier);
    const next = await tier.fetch();
    evidence = mergeEvidence(evidence, next);
    if (check(evidence)) {
      stoppedAt = tier.tier;
      return { evidence, stoppedAt, tiersTried, sufficient: true };
    }
  }

  return { evidence, stoppedAt, tiersTried, sufficient: check(evidence) };
}

/** Map a platform adapter kind onto a cost tier. */
export function platformToSourceCostTier(platform: string): SourceCostTier {
  const p = platform.toLowerCase();
  if (p === "youtube" || p === "reddit") return "official_api";
  if (p === "web" || p === "tavily" || p === "exa") return "tavily_http";
  if (
    p === "instagram" ||
    p === "tiktok" ||
    p === "twitter" ||
    p === "threads" ||
    p === "linkedin"
  ) {
    return "apify_approved_low_cost";
  }
  if (p === "crm" || p === "knowledge" || p === "business_profile") {
    return "business_profile_knowledge_crm";
  }
  return "tavily_http";
}
