import { createHash } from "crypto";

export type ProspectEvidence = {
  source: string;
  url?: string;
  excerpt?: string;
  retrievedAt: string;
};

export type SocialNetworkId =
  | "LINKEDIN"
  | "INSTAGRAM"
  | "X"
  | "TIKTOK"
  | "YOUTUBE"
  | "FACEBOOK"
  | "THREADS"
  | "OTHER";

export type ProfileVerificationState = "VERIFIED" | "LIKELY" | "UNVERIFIED" | "CONFLICTED";

export type SocialProfileIdentity = {
  network: SocialNetworkId;
  canonicalProfileUrl: string;
  handle?: string;
  displayName?: string;
  evidence: ProspectEvidence[];
  confidence: number;
  verificationState: ProfileVerificationState;
  retrievedAt: string;
};

export type StructuredIcp = {
  entityType: "person" | "company" | "either";
  industry?: string;
  role?: string;
  location?: string;
  companySize?: string;
  signals: string[];
  keywords: string[];
  exclusions: string[];
  preferredNetworks: Array<"linkedin" | "instagram" | "x" | "tiktok" | "youtube" | "any">;
  desiredCount: number;
  rawQuery: string;
};

export type DiscoveryCostLimits = {
  maxCandidates: number;
  maxSources: number;
  maxExternalCalls: number;
  maxEstimatedCostCents: number;
  /** Maps to SourceSearchOptions.qualityBudget */
  maxResearchDepth: "FAST" | "STANDARD" | "DEEP";
};

export const DEFAULT_DISCOVERY_COST_LIMITS: DiscoveryCostLimits = {
  maxCandidates: 10,
  maxSources: 8,
  maxExternalCalls: 6,
  maxEstimatedCostCents: 50,
  maxResearchDepth: "STANDARD",
};

export type SocialProspectCandidateInput = {
  personName?: string;
  companyName?: string;
  role?: string;
  companyWebsite?: string;
  location?: string;
  linkedinUrl?: string;
  instagramUrl?: string;
  otherSocialUrls?: string[];
  socialIdentities?: SocialProfileIdentity[];
  sourceEvidence: ProspectEvidence[];
  sourceQuality?: string;
  confidence?: number;
  fitScore?: number;
  reasonSelected?: string;
  uncertaintyFlags?: string[];
  preferredNetworks?: string[];
  providerIdentifiers?: Record<string, string>;
  retrievedAt?: string;
  /** Internal QA decision retained for diagnostics (not always customer-visible) */
  qaDecision?: Record<string, unknown>;
};

const ROLE_HINTS =
  /\b(founders?|co-founders?|ceos?|ctos?|coos?|owners?|directors?|managers?|head of(?:\s+\w+)?|operations leaders?|vps?|creators?|dentists?|influencers?)\b/i;
const LOCATION_HINTS =
  /\b(uk|united kingdom|london|manchester|birmingham|scotland|wales|england|europe|eu|usa|us|new york|california)\b/i;
const SIZE_HINTS =
  /\b(\d{1,4}\s*[-–—to]+\s*\d{1,4}(?:\s*(?:employees?|people|staff|ftes?))?|\d{1,4}\s*(?:employees?|people|staff|ftes?)|(?:under|fewer than|less than|<)\s*\d{1,4}\s*(?:employees?|people|staff)?|(?:about|approx(?:imately)?|around|~)\s*\d{1,4}\s*(?:employees?|people|staff|ftes?)?|(?:small|mid[- ]?size|smes?)(?:\s+(?:firms?|companies|businesses?))?)\b/i;

/**
 * Convert natural language prospecting intent into a structured ICP.
 * Does not call LinkedIn Marketing APIs. Discovery uses research / web / first-party sources.
 */
export function parseProspectIntent(raw: string): StructuredIcp {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const entityType: StructuredIcp["entityType"] = /\b(compan(?:y|ies)|clinic|business|agency|saas|practice)\b/i.test(
    text,
  )
    ? /\b(founder|ceo|people|creators?|owners?|dentists?)\b/i.test(text)
      ? "either"
      : "company"
    : "person";

  // Desired count — do not treat headcount ("35 employees") as result count.
  const desiredMatch =
    text.match(/\b(?:top|find|get|return|show|need)\s*(\d{1,3})\b/i) ||
    text.match(/\b(\d{1,3})\s*(?:prospects?|results?|candidates|leads)\b/i);
  const desiredCount = Math.min(100, Math.max(1, desiredMatch ? Number(desiredMatch[1]) : 10));

  const preferredNetworks: StructuredIcp["preferredNetworks"] = [];
  if (/\blinkedin\b/i.test(text)) preferredNetworks.push("linkedin");
  if (/\binstagram\b/i.test(text)) preferredNetworks.push("instagram");
  if (/\b(twitter|\bx\b)\b/i.test(text)) preferredNetworks.push("x");
  if (/\btiktok\b/i.test(text)) preferredNetworks.push("tiktok");
  if (/\byoutube\b/i.test(text)) preferredNetworks.push("youtube");
  if (preferredNetworks.length === 0) preferredNetworks.push("any");

  const roleRaw = text.match(ROLE_HINTS)?.[1];
  let role = roleRaw ? roleRaw.replace(/s$/, "").toLowerCase() : undefined;
  if (role) {
    if (/^coo$|chief operating|operations leader|head of operations/.test(role)) role = "coo";
    else if (/^ceo$|chief executive/.test(role)) role = "ceo";
    else if (/co-?founder/.test(role)) role = "founder";
    else if (/head of/.test(role)) role = roleRaw!.toLowerCase();
  }
  // Prefer city when present alongside country (tighter EXACT geography).
  const city = text.match(/\b(london|manchester|birmingham|edinburgh|glasgow|bristol|leeds)\b/i)?.[1]?.toLowerCase();
  let location = city || text.match(/\b(united kingdom|uk)\b/i)?.[1]?.toLowerCase();
  if (!location) {
    location = text.match(LOCATION_HINTS)?.[1]?.toLowerCase();
  }
  // Normalize uk variants
  if (location === "united kingdom") location = "uk";

  const sizeRaw = text.match(SIZE_HINTS)?.[1];
  const companySize = sizeRaw ? sizeRaw.replace(/\s+/g, " ").trim().toLowerCase() : undefined;
  const exclusions: string[] = [];
  if (/\bnot\s+([a-z0-9 -]{2,40})/i.test(text)) {
    const m = text.match(/\bnot\s+([a-z0-9 -]{2,40})/i);
    if (m?.[1]) exclusions.push(m[1].trim());
  }

  const keywords = text
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 24);

  const signals: string[] = [];
  if (/hiring|expand|raised|launch/i.test(lower)) signals.push("growth_signal");
  if (/need|looking for|want|benefit|automation/i.test(lower)) signals.push("need_signal");

  let industry: string | undefined;
  for (const token of [
    "fintech",
    "dental",
    "ecommerce",
    "saas",
    "fitness",
    "agency",
    "coaching",
    "recruitment",
    "recruiting",
    "professional services",
    "professional-services",
    "accountancy",
    "accounting",
    "law",
    "legal",
    "logistics",
    "property",
    "property-management",
  ]) {
    if (lower.includes(token)) {
      industry = token.replace(/-/g, " ");
      break;
    }
  }

  return {
    entityType,
    industry,
    role: role || undefined,
    location: location || undefined,
    companySize: companySize || undefined,
    signals,
    keywords,
    exclusions,
    preferredNetworks,
    desiredCount,
    rawQuery: text,
  };
}

/** Compile NL prospecting query into mandatory vs optional constraints (QA/debug). */
export function compileProspectConstraints(raw: string): {
  mandatory: Record<string, string>;
  optional: Record<string, string>;
  icp: StructuredIcp;
} {
  const icp = parseProspectIntent(raw);
  const mandatory: Record<string, string> = {};
  const optional: Record<string, string> = {};
  if (icp.role) mandatory.role = icp.role;
  if (icp.location) mandatory.location = icp.location;
  if (icp.companySize) mandatory.companySize = icp.companySize;
  if (icp.industry) mandatory.industry = icp.industry;
  if (icp.signals.includes("need_signal")) optional.automationPain = "preferred";
  if (/ai[- ]?readiness|transformation hiring/i.test(raw)) {
    optional.evidencePreference = /transformation hiring/i.test(raw)
      ? "transformation_hiring"
      : "ai_readiness";
  }
  return { mandatory, optional, icp };
}

export function mergeDiscoveryCostLimits(
  icpDesired: number,
  overrides?: Partial<DiscoveryCostLimits>,
): DiscoveryCostLimits {
  const base = { ...DEFAULT_DISCOVERY_COST_LIMITS };
  base.maxCandidates = Math.min(base.maxCandidates, Math.max(1, icpDesired));

  /** Server hard ceiling — client cannot raise these. */
  const CEILING: DiscoveryCostLimits = {
    maxCandidates: 20,
    maxSources: 12,
    maxExternalCalls: 10,
    maxEstimatedCostCents: 100,
    maxResearchDepth: "DEEP",
  };

  const depthRank = { FAST: 0, STANDARD: 1, DEEP: 2 } as const;
  const requestedDepth = overrides?.maxResearchDepth ?? base.maxResearchDepth;
  const clampedDepth =
    depthRank[requestedDepth] <= depthRank[CEILING.maxResearchDepth]
      ? requestedDepth
      : CEILING.maxResearchDepth;

  return {
    maxCandidates: Math.min(
      CEILING.maxCandidates,
      Math.max(1, overrides?.maxCandidates ?? base.maxCandidates),
    ),
    maxSources: Math.min(
      CEILING.maxSources,
      Math.max(1, overrides?.maxSources ?? base.maxSources),
    ),
    maxExternalCalls: Math.min(
      CEILING.maxExternalCalls,
      Math.max(1, overrides?.maxExternalCalls ?? base.maxExternalCalls),
    ),
    maxEstimatedCostCents: Math.min(
      CEILING.maxEstimatedCostCents,
      Math.max(1, overrides?.maxEstimatedCostCents ?? base.maxEstimatedCostCents),
    ),
    maxResearchDepth: clampedDepth,
  };
}

export function buildProspectDedupeKey(input: SocialProspectCandidateInput): string {
  const primaryIdentity =
    input.socialIdentities?.find((i) => i.verificationState === "VERIFIED" || i.verificationState === "LIKELY")
      ?.canonicalProfileUrl || "";
  const parts = [
    (input.linkedinUrl || "").toLowerCase().replace(/\/$/, ""),
    (input.instagramUrl || "").toLowerCase().replace(/\/$/, ""),
    primaryIdentity.toLowerCase().replace(/\/$/, ""),
    (input.companyWebsite || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, ""),
    (input.personName || "").toLowerCase().trim(),
    (input.companyName || "").toLowerCase().trim(),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

export function normalizeLinkedInUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!/^https?:\/\/([a-z]+\.)?linkedin\.com\//i.test(trimmed)) return undefined;
  try {
    const u = new URL(trimmed);
    const path = u.pathname.replace(/\/$/, "");
    if (!/^\/(in|company|school)\//i.test(path)) return undefined;
    return `https://www.linkedin.com${path}`;
  } catch {
    return undefined;
  }
}

export function normalizeInstagramUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!/^https?:\/\/(www\.)?instagram\.com\//i.test(trimmed)) return undefined;
  const path = trimmed.split("?")[0].replace(/\/$/, "");
  // Reject posts, listicles, discovery pages — only /{handle} profiles qualify
  if (/instagram\.com\/(p|reel|tv|popular|explore|directory|tags|locations?|stories)\//i.test(path)) {
    return undefined;
  }
  if (/instagram\.com\/[^/]+\/.+/i.test(path)) return undefined;
  return path;
}

export function buildResearchQueries(icp: StructuredIcp): string[] {
  const geo =
    icp.location === "london" || icp.location === "manchester" || icp.location === "birmingham"
      ? `${icp.location} UK`
      : icp.location === "uk"
        ? "UK"
        : icp.location;
  const bits = [
    icp.role,
    icp.industry,
    geo,
    icp.entityType === "company" ? "company" : icp.role || "founder",
    ...icp.keywords.slice(0, 6),
  ].filter(Boolean);
  const primary = bits.join(" ").trim() || icp.rawQuery;
  const queries = [primary];
  if (icp.preferredNetworks.includes("linkedin") || icp.preferredNetworks.includes("any")) {
    queries.push(`${primary} site:linkedin.com/in`);
  }
  if (icp.preferredNetworks.includes("instagram")) {
    // Creator-oriented Instagram queries — prefer profile pages over listicles
    const creatorBits = [icp.industry, geo, icp.role || "creator", "Instagram"].filter(Boolean).join(" ");
    queries.push(`${creatorBits} site:instagram.com`);
    queries.push(`"${icp.industry || "creator"}" ${geo || ""} Instagram profile -privacy -terms`.trim());
    queries.push(`${creatorBits} @instagram`);
  }
  if (icp.preferredNetworks.includes("youtube")) {
    queries.push(`${primary} site:youtube.com/@`);
  }
  if (icp.companySize) {
    queries.push(`${primary} ${icp.companySize} employees`);
    queries.push(`${icp.industry || icp.role || "company"} ${geo || ""} ${icp.companySize} staff headcount`.trim());
  }
  return [...new Set(queries)].slice(0, 8);
}
