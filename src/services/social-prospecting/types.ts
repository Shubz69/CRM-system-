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
  /\b(founders?|co-founders?|ceos?|ctos?|owners?|directors?|managers?|head of|vps?|creators?|dentists?|influencers?)\b/i;
const LOCATION_HINTS =
  /\b(uk|united kingdom|london|manchester|birmingham|scotland|wales|england|europe|eu|usa|us|new york|california)\b/i;

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

  const desiredMatch = text.match(/\b(\d{1,3})\b/);
  const desiredCount = Math.min(100, Math.max(1, desiredMatch ? Number(desiredMatch[1]) : 10));

  const preferredNetworks: StructuredIcp["preferredNetworks"] = [];
  if (/\blinkedin\b/i.test(text)) preferredNetworks.push("linkedin");
  if (/\binstagram\b/i.test(text)) preferredNetworks.push("instagram");
  if (/\b(twitter|\bx\b)\b/i.test(text)) preferredNetworks.push("x");
  if (/\btiktok\b/i.test(text)) preferredNetworks.push("tiktok");
  if (/\byoutube\b/i.test(text)) preferredNetworks.push("youtube");
  if (preferredNetworks.length === 0) preferredNetworks.push("any");

  const roleRaw = text.match(ROLE_HINTS)?.[1];
  const role = roleRaw ? roleRaw.replace(/s$/, "").toLowerCase() : undefined;
  // Prefer country/region context: "UK" wins over bare city when both present
  let location = text.match(/\b(united kingdom|uk)\b/i)?.[1]?.toLowerCase();
  if (!location) {
    location = text.match(LOCATION_HINTS)?.[1]?.toLowerCase();
  }
  // Normalize uk variants
  if (location === "united kingdom") location = "uk";

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
  ]) {
    if (lower.includes(token)) {
      industry = token;
      break;
    }
  }

  return {
    entityType,
    industry,
    role: role || undefined,
    location: location || undefined,
    signals,
    keywords,
    exclusions,
    preferredNetworks,
    desiredCount,
    rawQuery: text,
  };
}

export function mergeDiscoveryCostLimits(
  icpDesired: number,
  overrides?: Partial<DiscoveryCostLimits>,
): DiscoveryCostLimits {
  const base = { ...DEFAULT_DISCOVERY_COST_LIMITS };
  base.maxCandidates = Math.min(base.maxCandidates, Math.max(1, icpDesired));
  return { ...base, ...overrides, maxCandidates: overrides?.maxCandidates ?? base.maxCandidates };
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
  // Reject bare /p/ posts as profile identities
  if (/instagram\.com\/(p|reel|tv)\//i.test(path)) return undefined;
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
  if (icp.location && icp.industry) {
    queries.push(`${icp.industry} ${icp.role || "founder"} ${geo}`);
  }
  return [...new Set(queries)].slice(0, 6);
}
