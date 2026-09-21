/**
 * Business-entity resolution for research retrieval.
 * Distinguishes the workspace brand from homographs (Tonaura vs NAURA)
 * without dropping general market sources that never mention the brand.
 */

export type EntityClass =
  | "CONFIRMED_ENTITY"
  | "MARKET_CONTEXT"
  | "AMBIGUOUS_ENTITY"
  | "WRONG_ENTITY";

export type BusinessIdentity = {
  canonicalName: string;
  aliases: string[];
  domains: string[];
  productNames: string[];
  industry?: string;
  audience?: string;
  geography?: string;
  excludedEntities: string[];
};

export type ClassifiableSource = {
  url: string;
  title?: string | null;
  content?: string | null;
};

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function wordBoundaryHas(haystack: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length < 3) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/** Likely ticker / truncation homographs: Tonaura → NAURA / Onaura. */
export function likelyHomographs(canonicalName: string): string[] {
  const compactName = compact(canonicalName);
  const out: string[] = [];
  if (compactName.length >= 6) {
    out.push(compactName.slice(1));
    out.push(compactName.slice(2));
  }
  const spaced = canonicalName.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (spaced !== canonicalName) out.push(spaced);
  return unique(out).filter((h) => compact(h) !== compactName && compact(h).length >= 4);
}

export function identityFromProfile(profile: {
  organisation?: { name?: string | null; slug?: string | null } | null;
  products?: Array<{ name?: string | null }>;
  audiences?: Array<{ name?: string | null }>;
  claims?: Array<{ predicate?: string | null; valueText?: string | null }>;
} | null | undefined): BusinessIdentity | null {
  const name = profile?.organisation?.name?.trim();
  if (!name) return null;
  const aliases = unique([
    profile?.organisation?.slug?.replace(/-/g, " ") || "",
    ...((profile?.products || []).map((p) => p.name || "")),
  ]).filter((a) => a.toLowerCase() !== name.toLowerCase());
  const domains: string[] = [];
  for (const claim of profile?.claims || []) {
    const text = `${claim.predicate || ""} ${claim.valueText || ""}`;
    const match = text.match(/\b([a-z0-9-]+\.[a-z]{2,})(?:\/|\s|$)/i);
    if (match?.[1] && !/^(gmail|google|outlook)\./i.test(match[1])) {
      domains.push(match[1].replace(/^www\./, "").toLowerCase());
    }
  }
  const industry = (profile?.claims || []).find((c) =>
    /industry|category|sector/i.test(String(c.predicate || "")),
  )?.valueText;
  const audience =
    (profile?.audiences || [])
      .map((a) => a.name)
      .filter(Boolean)
      .slice(0, 2)
      .join("; ") ||
    (profile?.claims || []).find((c) => /audience|who_to_reach|who you reach/i.test(String(c.predicate || "")))
      ?.valueText;
  const geography = (profile?.claims || []).find((c) =>
    /geo|region|country|location/i.test(String(c.predicate || "")),
  )?.valueText;
  return {
    canonicalName: name,
    aliases,
    domains: unique(domains),
    productNames: unique((profile?.products || []).map((p) => p.name || "")).slice(0, 6),
    industry: industry?.trim() || undefined,
    audience: audience?.trim() || undefined,
    geography: geography?.trim() || undefined,
    excludedEntities: likelyHomographs(name),
  };
}

/**
 * Brand-specific: the user is asking about THIS company.
 * Market: the company is only context for an industry/trend search.
 */
export function isBrandSpecificQuery(topic: string, identity: BusinessIdentity): boolean {
  const t = topic.toLowerCase();
  const name = identity.canonicalName.toLowerCase();
  if (!t.includes(name.toLowerCase()) && !identity.aliases.some((a) => t.includes(a.toLowerCase()))) {
    return false;
  }
  return (
    /\b(about|reviews? of|saying about|reputation|mentions? of|news about|people (saying|think)|our (brand|company|studio))\b/i.test(
      topic,
    ) || /\bwhat is\b.{0,20}\b(tonaura|lifekeep)\b/i.test(topic)
  );
}

export function classifySourceEntity(
  source: ClassifiableSource,
  identity: BusinessIdentity,
  opts?: { brandSpecific?: boolean },
): EntityClass {
  const blob = `${source.url}\n${source.title || ""}\n${source.content || ""}`;
  const host = (() => {
    try {
      return new URL(source.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  })();

  if (identity.domains.some((d) => host === d || host.endsWith(`.${d}`))) {
    return "CONFIRMED_ENTITY";
  }

  const canonical = identity.canonicalName;
  const confirmed =
    wordBoundaryHas(blob, canonical) ||
    identity.aliases.some((a) => a.length >= 4 && wordBoundaryHas(blob, a)) ||
    identity.productNames.some((p) => p.length >= 5 && wordBoundaryHas(blob, p));

  const wrongHit = identity.excludedEntities.some(
    (ex) => wordBoundaryHas(blob, ex) && !wordBoundaryHas(blob, canonical),
  );

  if (confirmed && wrongHit) return "AMBIGUOUS_ENTITY";
  if (confirmed) {
    // Same legal name, different company (Tonaura wellness vs Tonaura solfeggio).
    const contextBits = [identity.industry, identity.audience, ...identity.productNames]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 5);
    const blobLower = blob.toLowerCase();
    const contextHit = contextBits.some((t) => blobLower.includes(t));
    if (opts?.brandSpecific && !contextHit) return "AMBIGUOUS_ENTITY";
    return "CONFIRMED_ENTITY";
  }
  if (wrongHit) return "WRONG_ENTITY";
  return "MARKET_CONTEXT";
}

export function filterSourcesForEntity<T extends ClassifiableSource>(
  sources: T[],
  identity: BusinessIdentity | null,
  brandSpecific: boolean,
): { kept: T[]; droppedWrong: T[]; classifications: Array<{ url: string; entityClass: EntityClass }> } {
  if (!identity) {
    return {
      kept: sources,
      droppedWrong: [],
      classifications: sources.map((s) => ({ url: s.url, entityClass: "MARKET_CONTEXT" as const })),
    };
  }
  const classifications: Array<{ url: string; entityClass: EntityClass }> = [];
  const kept: T[] = [];
  const droppedWrong: T[] = [];
  for (const source of sources) {
    const entityClass = classifySourceEntity(source, identity, { brandSpecific });
    classifications.push({ url: source.url, entityClass });
    if (entityClass === "WRONG_ENTITY") {
      droppedWrong.push(source);
      continue;
    }
    if (brandSpecific && entityClass === "AMBIGUOUS_ENTITY") continue;
    if (brandSpecific && entityClass === "MARKET_CONTEXT") continue;
    kept.push(source);
  }
  // Brand-specific with nothing confirmed: do not silently refill with WRONG_ENTITY.
  if (brandSpecific && kept.length === 0) {
    return { kept: [], droppedWrong, classifications };
  }
  return { kept, droppedWrong, classifications };
}

export function expandResearchQueries(
  topic: string,
  identity: BusinessIdentity | null,
  cap: number,
): string[] {
  const year = new Date().getFullYear();
  const excludes = (identity?.excludedEntities || [])
    .slice(0, 3)
    .map((e) => `-${e}`)
    .join(" ");
  const marketBits = [identity?.industry, identity?.audience, identity?.geography]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const out: string[] = [];
  const push = (q: string) => {
    const cleaned = q.replace(/\s+/g, " ").trim();
    if (cleaned.length >= 3 && !out.some((x) => x.toLowerCase() === cleaned.toLowerCase())) {
      out.push(cleaned.slice(0, 220));
    }
  };
  push(topic);
  push(`${topic} ${year}`);
  if (identity) {
    push(`${identity.canonicalName} ${marketBits} ${year} ${excludes}`.trim());
    if (marketBits) {
      const stripped = topic.replace(new RegExp(identity.canonicalName, "ig"), " ").replace(/\s+/g, " ").trim();
      push(`${stripped} ${marketBits} ${year}`.trim());
    }
    if (identity.productNames[0]) {
      push(`${identity.productNames[0]} ${marketBits} ${year}`.trim());
    }
    if (isBrandSpecificQuery(topic, identity)) {
      push(`"${identity.canonicalName}" reviews ${year} ${excludes}`.trim());
      if (identity.domains[0]) push(`site:${identity.domains[0]} ${topic}`.trim());
    }
  }
  return out.slice(0, Math.max(1, cap));
}
