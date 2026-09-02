/**
 * Provider-independent social identity resolution.
 * Never invents profile URLs. Never constructs LinkedIn URLs from names alone.
 */

import type { SourceResult } from "@/adapters/sources/types";
import type {
  ProspectEvidence,
  SocialNetworkId,
  SocialProfileIdentity,
  SocialProspectCandidateInput,
  ProfileVerificationState,
} from "@/services/social-prospecting/types";
import { normalizeInstagramUrl, normalizeLinkedInUrl } from "@/services/social-prospecting/types";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function evidenceFromSource(r: SourceResult, excerpt?: string): ProspectEvidence {
  return {
    source: r.platform,
    url: r.url,
    excerpt: (excerpt || r.content || r.title || "").slice(0, 280),
    retrievedAt: new Date().toISOString(),
  };
}

export function detectNetworkFromUrl(url: string): SocialNetworkId | null {
  const u = url.toLowerCase();
  if (/linkedin\.com\/(in|company|school)\//i.test(u)) return "LINKEDIN";
  if (/instagram\.com\//i.test(u) && !/instagram\.com\/(p|reel|tv)\//i.test(u)) return "INSTAGRAM";
  if (/(?:\/\/|\.)(twitter|x)\.com\//i.test(u) && !/\/status\//i.test(u)) return "X";
  if (/tiktok\.com\/@/i.test(u)) return "TIKTOK";
  if (/youtube\.com\/(@|channel\/|c\/)/i.test(u)) return "YOUTUBE";
  if (/facebook\.com\//i.test(u) && !/\/posts?\//i.test(u)) return "FACEBOOK";
  if (/threads\.net\/@/i.test(u)) return "THREADS";
  return null;
}

export function canonicalizeProfileUrl(network: SocialNetworkId, raw: string): string | undefined {
  const cleaned = raw.split("?")[0].replace(/\/$/, "");
  // Reject privacy / legal / navigation destinations as profile identities
  if (/\/(privacy|legal|terms|cookie|about|help|explore|accounts|directory)\b/i.test(cleaned)) {
    return undefined;
  }
  if (/instagram\.com\/(privacy|legal|about|developer)/i.test(cleaned)) return undefined;
  switch (network) {
    case "LINKEDIN":
      return normalizeLinkedInUrl(cleaned);
    case "INSTAGRAM":
      return normalizeInstagramUrl(cleaned);
    case "X": {
      try {
        const u = new URL(cleaned);
        const handle = u.pathname.split("/").filter(Boolean)[0];
        if (!handle || ["home", "explore", "search", "i"].includes(handle.toLowerCase())) return undefined;
        return `https://x.com/${handle}`;
      } catch {
        return undefined;
      }
    }
    case "TIKTOK": {
      const m = cleaned.match(/tiktok\.com\/(@[^/]+)/i);
      return m ? `https://www.tiktok.com/${m[1]}` : undefined;
    }
    case "YOUTUBE":
      return cleaned;
    case "FACEBOOK":
      return cleaned;
    case "THREADS": {
      const m = cleaned.match(/threads\.net\/(@[^/]+)/i);
      return m ? `https://www.threads.net/${m[1]}` : undefined;
    }
    default:
      return cleaned.startsWith("http") ? cleaned : undefined;
  }
}

export function extractProfileUrlsFromText(text: string): Array<{ network: SocialNetworkId; url: string }> {
  const out: Array<{ network: SocialNetworkId; url: string }> = [];
  const matches = text.match(URL_RE) || [];
  for (const raw of matches) {
    const network = detectNetworkFromUrl(raw);
    if (!network) continue;
    const canonical = canonicalizeProfileUrl(network, raw);
    if (!canonical) continue;
    out.push({ network, url: canonical });
  }
  return out;
}

function handleFromUrl(network: SocialNetworkId, url: string): string | undefined {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (network === "LINKEDIN") return parts[1];
    if (network === "INSTAGRAM" || network === "X" || network === "FACEBOOK") return parts[0];
    if (network === "TIKTOK" || network === "THREADS") return parts[0]?.replace(/^@/, "");
    if (network === "YOUTUBE") return parts.join("/");
  } catch {
    return undefined;
  }
  return undefined;
}

function nameTokens(name?: string): string[] {
  return (name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Score whether a profile URL plausibly belongs to the candidate.
 * Never invents URLs — only verifies candidates against evidence.
 */
export function verifyProfileAgainstCandidate(input: {
  network: SocialNetworkId;
  url: string;
  personName?: string;
  companyName?: string;
  role?: string;
  location?: string;
  evidenceText: string;
}): { verificationState: ProfileVerificationState; confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  const hay = `${input.url} ${input.evidenceText}`.toLowerCase();
  const personToks = nameTokens(input.personName);
  const companyToks = nameTokens(input.companyName);
  const urlLower = input.url.toLowerCase();

  let hits = 0;
  for (const t of personToks) {
    if (urlLower.includes(t) || hay.includes(t)) {
      hits += 1;
      reasons.push(`name_token:${t}`);
    }
  }
  for (const t of companyToks.slice(0, 3)) {
    if (hay.includes(t)) {
      hits += 1;
      reasons.push(`company_token:${t}`);
    }
  }
  if (input.role && hay.includes(input.role.toLowerCase())) {
    hits += 1;
    reasons.push("role_mentioned");
  }
  if (input.location && hay.includes(input.location.toLowerCase())) {
    hits += 0.5;
    reasons.push("location_mentioned");
  }

  // Wrong-profile prevention: person profiles must reflect the name in the URL itself
  // (never promote a rival slug merely because evidence text mentions the person nearby)
  // Company LinkedIn pages are never person profiles
  if (input.network === "LINKEDIN" && /linkedin\.com\/(company|school)\//i.test(urlLower)) {
    return {
      verificationState: "UNVERIFIED",
      confidence: 0.1,
      reasons: ["company_page_not_person_profile"],
    };
  }

  const nameInUrl = personToks.some((t) => urlLower.includes(t));
  if (personToks.length && !nameInUrl) {
    const isPersonProfilePath =
      input.network === "LINKEDIN" ||
      input.network === "INSTAGRAM" ||
      input.network === "X" ||
      input.network === "TIKTOK" ||
      input.network === "THREADS";
    if (isPersonProfilePath) {
      return {
        verificationState: "UNVERIFIED",
        confidence: 0.15,
        reasons: ["name_not_in_profile_url"],
      };
    }
  }

  if (personToks.length && !personToks.some((t) => urlLower.includes(t) || hay.includes(t))) {
    return {
      verificationState: "UNVERIFIED",
      confidence: 0.15,
      reasons: ["name_not_supported_by_url_or_evidence"],
    };
  }

  if (hits >= 3 && nameInUrl) {
    return { verificationState: "VERIFIED", confidence: Math.min(0.92, 0.55 + hits * 0.1), reasons };
  }
  if (hits >= 2 && (nameInUrl || companyToks.some((t) => hay.includes(t)))) {
    return { verificationState: "LIKELY", confidence: Math.min(0.75, 0.4 + hits * 0.1), reasons };
  }
  if (hits >= 1) {
    return { verificationState: "UNVERIFIED", confidence: 0.35, reasons };
  }
  return { verificationState: "UNVERIFIED", confidence: 0.2, reasons: ["weak_identity_link"] };
}

export function resolveIdentitiesForCandidate(input: {
  personName?: string;
  companyName?: string;
  role?: string;
  location?: string;
  sourceResults: SourceResult[];
  extraUrls?: string[];
}): SocialProfileIdentity[] {
  const byNetwork = new Map<SocialNetworkId, SocialProfileIdentity[]>();
  const corpus = input.sourceResults
    .map((r) => `${r.title}\n${r.content}\n${r.url}\n${r.author || ""}`)
    .join("\n");

  const discovered: Array<{ network: SocialNetworkId; url: string; evidence: ProspectEvidence }> = [];

  for (const r of input.sourceResults) {
    const network = detectNetworkFromUrl(r.url);
    if (network) {
      const canonical = canonicalizeProfileUrl(network, r.url);
      if (canonical) {
        discovered.push({ network, url: canonical, evidence: evidenceFromSource(r) });
      }
    }
    for (const hit of extractProfileUrlsFromText(`${r.title}\n${r.content}`)) {
      discovered.push({
        network: hit.network,
        url: hit.url,
        evidence: evidenceFromSource(r, `Profile URL found in ${r.platform} result`),
      });
    }
  }

  for (const raw of input.extraUrls || []) {
    const network = detectNetworkFromUrl(raw);
    if (!network) continue;
    const canonical = canonicalizeProfileUrl(network, raw);
    if (!canonical) continue;
    discovered.push({
      network,
      url: canonical,
      evidence: {
        source: "provided",
        url: canonical,
        excerpt: "Caller-supplied profile URL",
        retrievedAt: new Date().toISOString(),
      },
    });
  }

  for (const d of discovered) {
    const check = verifyProfileAgainstCandidate({
      network: d.network,
      url: d.url,
      personName: input.personName,
      companyName: input.companyName,
      role: input.role,
      location: input.location,
      evidenceText: corpus,
    });
    const identity: SocialProfileIdentity = {
      network: d.network,
      canonicalProfileUrl: d.url,
      handle: handleFromUrl(d.network, d.url),
      displayName: input.personName || input.companyName,
      evidence: [d.evidence],
      confidence: check.confidence,
      verificationState: check.verificationState,
      retrievedAt: new Date().toISOString(),
    };
    const list = byNetwork.get(d.network) || [];
    list.push(identity);
    byNetwork.set(d.network, list);
  }

  const resolved: SocialProfileIdentity[] = [];
  for (const [, list] of byNetwork) {
    const unique = new Map<string, SocialProfileIdentity>();
    for (const id of list) {
      const prev = unique.get(id.canonicalProfileUrl);
      if (!prev || id.confidence > prev.confidence) unique.set(id.canonicalProfileUrl, id);
    }
    const values = [...unique.values()].sort((a, b) => b.confidence - a.confidence);
    if (values.length > 1) {
      // Conflicting profiles for same network
      const top = values[0]!;
      const rival = values[1]!;
      if (top.canonicalProfileUrl !== rival.canonicalProfileUrl && Math.abs(top.confidence - rival.confidence) < 0.15) {
        resolved.push({
          ...top,
          verificationState: "CONFLICTED",
          confidence: Math.min(top.confidence, 0.45),
          evidence: [...top.evidence, ...rival.evidence],
        });
        continue;
      }
    }
    if (values[0]) resolved.push(values[0]);
  }

  return resolved;
}

/** Attach verified/likely profile links onto a candidate — never invent missing URLs. */
export function applyIdentitiesToCandidate(
  candidate: SocialProspectCandidateInput,
  identities: SocialProfileIdentity[],
): SocialProspectCandidateInput {
  const showable = identities.filter((i) => i.verificationState === "VERIFIED" || i.verificationState === "LIKELY");
  const linkedin = showable.find((i) => i.network === "LINKEDIN");
  const instagram = showable.find((i) => i.network === "INSTAGRAM");
  const uncertainty = [...(candidate.uncertaintyFlags || [])];
  if (identities.some((i) => i.verificationState === "CONFLICTED")) {
    uncertainty.push("conflicting_social_identities");
  }
  if (!showable.length && identities.length) {
    uncertainty.push("profile_not_verified");
  }

  // Only attach profile URLs that passed VERIFIED/LIKELY — never invent or keep unverified links for UX
  return {
    ...candidate,
    linkedinUrl: linkedin?.canonicalProfileUrl,
    instagramUrl: instagram?.canonicalProfileUrl,
    socialIdentities: identities,
    otherSocialUrls: showable
      .filter((i) => i.network !== "LINKEDIN" && i.network !== "INSTAGRAM")
      .map((i) => i.canonicalProfileUrl),
    uncertaintyFlags: uncertainty,
  };
}
