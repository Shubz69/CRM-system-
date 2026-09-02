/**
 * Strict prospect entity validation — reject garbage before presentation.
 * Separates fit (commercial) from identity/evidence quality.
 */

import type {
  ProspectEvidence,
  SocialProspectCandidateInput,
  StructuredIcp,
} from "@/services/social-prospecting/types";
import { normalizeInstagramUrl, normalizeLinkedInUrl } from "@/services/social-prospecting/types";

export type EntityClass = "PERSON" | "COMPANY" | "CREATOR" | "UNKNOWN";

export type RejectionCode =
  | "NOT_A_PERSON"
  | "ROLE_MISMATCH"
  | "LOCATION_MISMATCH"
  | "DUPLICATE_PROFILE"
  | "UNVERIFIED_PROFILE"
  | "COMPANY_MISMATCH"
  | "SCRAPED_FRAGMENT"
  | "INSUFFICIENT_EVIDENCE"
  | "PRIVACY_OR_LEGAL"
  | "COMPANY_PAGE_AS_PERSON"
  | "WEAK_COMPANY_NAME"
  | "IDENTITY_BELOW_GATE"
  | "INDUSTRY_MISMATCH"
  | "NON_PROFILE_URL";

export type ValidationDecision = {
  accepted: boolean;
  entityClass: EntityClass;
  rejectionCode?: RejectionCode;
  rejectionReason?: string;
  requestedRole?: string;
  matchedRole?: string;
  roleConfidence: number;
  roleEvidence?: string;
  requestedLocation?: string;
  candidateLocation?: string;
  locationConfidence: number;
  locationEvidence?: string;
  identityConfidence: number;
  fitScore: number;
  companyAssociationConfidence: number;
};

const FRAGMENT_PATTERNS = [
  /\bwho bring\b/i,
  /\bover \d+ years\b/i,
  /\bunited kingdom\s*[·•|]/i,
  /\brecruitment founders? club\b/i,
  /\babout us\b/i,
  /\bprivacy polic/i,
  /\bterms of (service|use)\b/i,
  /\bcookie polic/i,
  /\bclick here\b/i,
  /\bread more\b/i,
  /\btop \d+\b/i,
  /\bbest \d+\b/i,
  /\blisticle\b/i,
  /\bsubscribe\b/i,
  /\bsign (up|in)\b/i,
  /\bnavigation\b/i,
  /\bhome\s*[>|»]/i,
  /^https?:\/\//i,
  /\b\d{1,3}\s+(tips|ways|reasons|founders?|owners?)\b/i,
];

const LEGAL_OR_NAV_URL =
  /instagram\.com\/(about|legal|privacy|accounts|explore|directory|developer|popular|p\/|reel\/|tv\/|stories\/|tags\/|locations?\/)|linkedin\.com\/(legal|help|uas|authwall|pulse|posts\/)|\/privacy|\/terms|\/cookie/i;

/** Instagram URLs that are listicles / discovery pages, not creator profiles. */
const INSTAGRAM_NON_PROFILE =
  /instagram\.com\/(popular|explore|directory|about|legal|privacy|accounts|developer|p\/|reel\/|tv\/|stories\/|tags\/|locations?\/)(\/|$)/i;

const ROLE_FAMILIES: Record<string, RegExp[]> = {
  founder: [
    /\b(co[- ]?)?founders?\b/i,
    /\bfounding\s+(partner|member|ceo|cto)\b/i,
    /\bowner\s*[/&]\s*founder\b/i,
    /\bfounder\s*[&/]\s*ceo\b/i,
  ],
  owner: [/\bowners?\b/i, /\bproprietor\b/i, /\bprincipal\b/i, /\bpractice\s+owner\b/i],
  ceo: [/\bceo\b/i, /\bchief\s+executive\b/i, /\bmanaging\s+director\b/i],
  director: [/\bdirectors?\b/i, /\bmanaging\s+director\b/i, /\bnon[- ]executive\b/i],
  creator: [
    /\bcreators?\b/i,
    /\binfluencers?\b/i,
    /\bcontent\s+creator\b/i,
    /\bsocial\s+media\s+(creator|influencer)\b/i,
  ],
  dentist: [/\bdentists?\b/i, /\bdental\s+(surgeon|practitioner|principal)\b/i],
  recruiter: [/\brecruiters?\b/i, /\brecruitment\s+(consultant|specialist|expert)\b/i],
};

/** Roles that must NOT silently satisfy "founder/owner/ceo" intent. */
const NON_EQUIVALENT_TO_FOUNDER = /\b(recruiter|recruitment\s+expert|consultant|employee|account\s+executive|sales\s+rep)\b/i;

const UK_GEO_HINTS =
  /\b(uk|u\.k\.|united\s+kingdom|england|scotland|wales|britain|british|london|manchester|birmingham|leeds|bristol|edinburgh|glasgow|cardiff)\b/i;
const US_AMBIGUOUS_LONDON = /\blondon\s*,?\s*(ky|kentucky|ontario|canada|on)\b/i;

const WEAK_COMPANY_NAMES = [
  /^headless\b/i,
  /^united\s+kingdom$/i,
  /^about\b/i,
  /^home$/i,
  /^linkedin$/i,
  /^instagram$/i,
  /^click\b/i,
  /^here$/i,
  /\bwho bring\b/i,
  /^the\s+$/i,
  /^[a-z\s]{0,2}$/i,
];

export function classifyEntity(input: {
  personName?: string;
  companyName?: string;
  linkedinUrl?: string;
  instagramUrl?: string;
  role?: string;
  evidenceText: string;
}): EntityClass {
  const li = (input.linkedinUrl || "").toLowerCase();
  if (/linkedin\.com\/company\//i.test(li)) return "COMPANY";
  if (/linkedin\.com\/school\//i.test(li)) return "COMPANY";

  const name = (input.personName || "").trim();
  if (isScrapedFragment(name) || isPrivacyOrLegalText(name) || !isPlausibleHumanName(name)) {
    if (input.companyName && !isWeakCompanyName(input.companyName)) return "COMPANY";
    return "UNKNOWN";
  }

  if (/\bcreators?\b/i.test(input.role || "") || /\bcreators?\b/i.test(input.evidenceText)) {
    return "CREATOR";
  }
  if (name && (input.instagramUrl || /linkedin\.com\/in\//i.test(li))) return "PERSON";
  if (name) return "PERSON";
  if (input.companyName) return "COMPANY";
  return "UNKNOWN";
}

export function isPlausibleHumanName(name?: string | null): boolean {
  if (!name) return false;
  const n = name.trim();
  if (n.length < 3 || n.length > 60) return false;
  if (FRAGMENT_PATTERNS.some((p) => p.test(n))) return false;
  if (isScrapedFragment(n) || isPrivacyOrLegalText(n)) return false;
  if (/\d{2,}/.test(n)) return false;
  if (/[·•|–—]/.test(n)) return false;
  if (/[.!?]{2,}|\.{3}/.test(n)) return false;
  // Require 2–3 Capitalized name tokens (allow hyphenated / apostrophe)
  const tokens = n.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;
  const nameToken = /^[A-Z][a-zA-Z'’-]+$/;
  if (!tokens.every((t) => nameToken.test(t))) return false;
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "about",
    "over",
    "years",
    "united",
    "kingdom",
    "company",
    "ltd",
    "limited",
    "inc",
    "club",
    "who",
    "bring",
    "proven",
    "privacy",
    "policy",
    "instagram",
    "linkedin",
    "top",
    "best",
  ]);
  if (tokens.some((t) => stop.has(t.toLowerCase()))) return false;
  return true;
}

export function isScrapedFragment(text?: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 90) return true;
  if (FRAGMENT_PATTERNS.some((p) => p.test(t))) return true;
  if ((t.match(/\s/g) || []).length >= 12) return true;
  if (/^[a-z]/.test(t) && t.includes(" ")) return true; // sentence fragment
  return false;
}

export function isPrivacyOrLegalText(text?: string | null): boolean {
  if (!text) return false;
  return /\b(privacy|terms of|cookie|legal|gdpr|data protection)\b/i.test(text);
}

export function isWeakCompanyName(name?: string | null): boolean {
  if (!name) return true;
  const n = name.trim();
  if (n.length < 2 || n.length > 80) return true;
  if (WEAK_COMPANY_NAMES.some((p) => p.test(n))) return true;
  if (isScrapedFragment(n) || isPrivacyOrLegalText(n)) return true;
  if (!/[A-Za-z]/.test(n)) return true;
  // Trailing dash / em-dash fragments ("Alison Calder -")
  if (/[\s]*[-–—|·•]\s*$/.test(n)) return true;
  // Title scraps: "Morel - Founder and CEO - Tiger"
  if (/\b(founder|co[- ]?founder|ceo|cto|owner|director|manager)\b/i.test(n) && /[-–—]/.test(n)) {
    return true;
  }
  // Multiple dash-separated segments look like LinkedIn headlines, not companies
  if ((n.match(/[-–—]/g) || []).length >= 2) return true;
  return false;
}

/** True when company string is essentially the person's name (with optional junk). */
export function isPersonNameAsCompany(companyName?: string | null, personName?: string | null): boolean {
  if (!companyName || !personName) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[-–—|·•.,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const c = norm(companyName);
  const p = norm(personName);
  if (!c || !p) return false;
  if (c === p) return true;
  if (c.startsWith(p + " ") || p.startsWith(c)) return true;
  // First+last tokens equal
  const ct = c.split(" ").filter(Boolean);
  const pt = p.split(" ").filter(Boolean);
  if (pt.length >= 2 && ct.length >= 2 && ct[0] === pt[0] && ct[1] === pt[1]) return true;
  return false;
}

export function isRejectedProfileUrl(url?: string | null): boolean {
  if (!url) return false;
  if (LEGAL_OR_NAV_URL.test(url)) return true;
  if (INSTAGRAM_NON_PROFILE.test(url)) return true;
  // Instagram profile must be /{handle} only (optional trailing slash / query)
  const ig = url.match(/instagram\.com\/([^/?#]+)/i);
  if (ig) {
    const handle = ig[1] || "";
    if (
      /^(popular|explore|directory|about|legal|privacy|accounts|developer|p|reel|tv|stories|tags|locations?)$/i.test(
        handle,
      )
    ) {
      return true;
    }
    // Multi-segment path after handle (e.g. popular/manchester-fitness-influencers)
    if (/instagram\.com\/[^/]+\/.+/i.test(url.split("?")[0] || "")) return true;
  }
  return false;
}

function evidenceBlob(evidence: ProspectEvidence[]): string {
  return evidence.map((e) => `${e.excerpt || ""} ${e.url || ""} ${e.source}`).join("\n");
}

export function matchRoleIntent(
  requestedRole: string | undefined,
  evidenceText: string,
  candidateRole?: string,
): { matchedRole?: string; roleConfidence: number; roleEvidence?: string; ok: boolean } {
  if (!requestedRole) {
    return { roleConfidence: 0.5, ok: true, matchedRole: candidateRole };
  }
  const familyKey = Object.keys(ROLE_FAMILIES).find((k) =>
    new RegExp(k, "i").test(requestedRole),
  );
  const patterns = familyKey ? ROLE_FAMILIES[familyKey]! : [new RegExp(`\\b${escapeRe(requestedRole)}\\b`, "i")];
  const hay = `${candidateRole || ""}\n${evidenceText}`;

  for (const p of patterns) {
    const m = hay.match(p);
    if (m) {
      // Founder intent must not accept plain recruiter/consultant
      if (familyKey === "founder" && NON_EQUIVALENT_TO_FOUNDER.test(hay) && !patterns.some((x) => x.test(hay))) {
        continue;
      }
      if (familyKey === "founder" && NON_EQUIVALENT_TO_FOUNDER.test(m[0]) && !/\bfounder\b/i.test(hay)) {
        return {
          ok: false,
          roleConfidence: 0.15,
          matchedRole: m[0],
          roleEvidence: m[0],
        };
      }
      return {
        ok: true,
        matchedRole: m[0],
        roleConfidence: 0.85,
        roleEvidence: m[0],
      };
    }
  }

  // Explicit mismatch: recruiter for founder search
  if (familyKey === "founder" && NON_EQUIVALENT_TO_FOUNDER.test(hay) && !/\bfounder\b/i.test(hay)) {
    return { ok: false, roleConfidence: 0.1, matchedRole: "recruiter", roleEvidence: "role_mismatch" };
  }

  return { ok: false, roleConfidence: 0.2, matchedRole: candidateRole };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchLocationIntent(
  icp: StructuredIcp,
  evidenceText: string,
  candidateLocation?: string,
): {
  ok: boolean;
  locationConfidence: number;
  candidateLocation?: string;
  locationEvidence?: string;
} {
  const requested = icp.location;
  if (!requested) {
    return { ok: true, locationConfidence: 0.5, candidateLocation };
  }

  // Evidence only — never treat the ICP query string as location proof
  // (otherwise every London search "proves" London for Manchester candidates).
  const hay = `${candidateLocation || ""}\n${evidenceText}`.toLowerCase();
  const req = requested.toLowerCase().trim();

  const queryIsUk =
    UK_GEO_HINTS.test(icp.rawQuery) ||
    /\buk\b/i.test(icp.rawQuery) ||
    req === "london" ||
    req === "manchester" ||
    req === "birmingham";

  if (queryIsUk && US_AMBIGUOUS_LONDON.test(hay)) {
    return {
      ok: false,
      locationConfidence: 0.05,
      candidateLocation: "London, Kentucky (ambiguous)",
      locationEvidence: "ambiguous_non_uk_london",
    };
  }

  // Country-level UK: any UK geo hint in evidence is OK
  if (req === "uk" || req === "united kingdom" || req === "britain" || req === "england") {
    const m = hay.match(UK_GEO_HINTS);
    if (m) {
      return {
        ok: true,
        locationConfidence: 0.75,
        candidateLocation: candidateLocation || m[0],
        locationEvidence: m[0],
      };
    }
    return {
      ok: false,
      locationConfidence: 0.15,
      candidateLocation,
      locationEvidence: "location_not_in_evidence",
    };
  }

  // City-level: require that specific city (or clear synonym) — not a different UK city
  const cityRe = new RegExp(`\\b${escapeRe(req)}\\b`, "i");
  const cityMatch = hay.match(cityRe);
  if (cityMatch) {
    return {
      ok: true,
      locationConfidence: 0.85,
      candidateLocation: candidateLocation || cityMatch[0],
      locationEvidence: cityMatch[0],
    };
  }

  return {
    ok: false,
    locationConfidence: 0.15,
    candidateLocation,
    locationEvidence: "location_not_in_evidence",
  };
}

export function matchIndustryIntent(
  industry: string | undefined,
  evidenceText: string,
  candidateRole?: string,
  companyName?: string,
): { ok: boolean; confidence: number; evidence?: string } {
  if (!industry?.trim()) return { ok: true, confidence: 0.5 };
  const token = industry.trim().toLowerCase();
  const hay = `${candidateRole || ""}\n${companyName || ""}\n${evidenceText}`.toLowerCase();
  const synonyms: Record<string, RegExp> = {
    dental: /\b(dental|dentist|dentistry|orthodont|oral\s+health|teeth|tooth)\b/i,
    recruitment: /\b(recruit(?:ment|er|ing)?|talent\s+acquisition|staffing|headhunt)\b/i,
    fitness: /\b(fitness|gym|personal\s+train|workout|crossfit|wellness)\b/i,
  };
  const re = synonyms[token] || new RegExp(`\\b${escapeRe(token)}\\b`, "i");
  const m = hay.match(re);
  if (m) return { ok: true, confidence: 0.8, evidence: m[0] };
  return { ok: false, confidence: 0.1 };
}

export function companyAssociationConfidence(input: {
  companyName?: string;
  personName?: string;
  evidence: ProspectEvidence[];
}): number {
  if (!input.companyName || isWeakCompanyName(input.companyName)) return 0;
  const blob = evidenceBlob(input.evidence).toLowerCase();
  const company = input.companyName.toLowerCase();
  const personFirst = input.personName?.toLowerCase().split(/\s+/)[0];
  if (!blob.includes(company.split(/\s+/)[0] || company)) return 0.15;
  if (personFirst && blob.includes(personFirst) && blob.includes(company.split(/\s+/)[0]!)) {
    return 0.85;
  }
  if (blob.includes(company)) return 0.7;
  return 0.35;
}

export function identityConfidenceOf(candidate: SocialProspectCandidateInput): number {
  const ids = candidate.socialIdentities || [];
  if (!ids.length) {
    if (candidate.linkedinUrl || candidate.instagramUrl) return 0.4;
    return 0.2;
  }
  const best = Math.max(
    0,
    ...ids.map((i) => {
      if (i.verificationState === "VERIFIED") return Math.max(i.confidence, 0.8);
      if (i.verificationState === "LIKELY") return Math.max(i.confidence, 0.6);
      if (i.verificationState === "CONFLICTED") return 0.3;
      return i.confidence * 0.5;
    }),
  );
  return best;
}

/** Hard gates before a prospect may appear in the normal results list. */
export function validateProspectCandidate(
  candidate: SocialProspectCandidateInput,
  icp: StructuredIcp,
  opts?: { requireVerifiedProfile?: boolean; seenProfileUrls?: Set<string> },
): ValidationDecision {
  const evidenceText = evidenceBlob(candidate.sourceEvidence || []);
  const linkedinUrl = normalizeLinkedInUrl(candidate.linkedinUrl);
  const instagramUrl = normalizeInstagramUrl(candidate.instagramUrl);

  if (isRejectedProfileUrl(linkedinUrl) || isRejectedProfileUrl(instagramUrl)) {
    return reject("PRIVACY_OR_LEGAL", "Privacy/legal/navigation URL", candidate, icp);
  }

  for (const e of candidate.sourceEvidence || []) {
    if (isRejectedProfileUrl(e.url) && /privacy|terms|legal/i.test(`${e.excerpt || ""}${e.url}`)) {
      return reject("PRIVACY_OR_LEGAL", "Privacy or legal page", candidate, icp);
    }
  }

  const entityClass = classifyEntity({
    personName: candidate.personName,
    companyName: candidate.companyName,
    linkedinUrl,
    instagramUrl,
    role: candidate.role,
    evidenceText,
  });

  // Company LinkedIn pages are never person profiles for people ICP
  if (
    (icp.entityType === "person" || icp.entityType === "either") &&
    /linkedin\.com\/(company|school)\//i.test(linkedinUrl || "")
  ) {
    return reject(
      "COMPANY_PAGE_AS_PERSON",
      "Company LinkedIn page cannot be a person",
      candidate,
      icp,
      "COMPANY",
    );
  }

  if (icp.entityType === "person" || icp.entityType === "either") {
    if (entityClass === "UNKNOWN" || entityClass === "COMPANY") {
      if (!isPlausibleHumanName(candidate.personName)) {
        return reject(
          isScrapedFragment(candidate.personName) ? "SCRAPED_FRAGMENT" : "NOT_A_PERSON",
          "Not a plausible person entity",
          candidate,
          icp,
          entityClass,
        );
      }
    }
    if (!isPlausibleHumanName(candidate.personName)) {
      return reject(
        isScrapedFragment(candidate.personName) ? "SCRAPED_FRAGMENT" : "NOT_A_PERSON",
        "Name failed person validation",
        candidate,
        icp,
        entityClass,
      );
    }
  } else if (entityClass === "UNKNOWN" && !candidate.companyName) {
    return reject("INSUFFICIENT_EVIDENCE", "Unknown entity", candidate, icp, entityClass);
  }

  const role = matchRoleIntent(icp.role, evidenceText, candidate.role);
  if (icp.role && !role.ok) {
    return {
      ...reject("ROLE_MISMATCH", "Requested role not supported by evidence", candidate, icp, entityClass),
      requestedRole: icp.role,
      matchedRole: role.matchedRole,
      roleConfidence: role.roleConfidence,
      roleEvidence: role.roleEvidence,
    };
  }

  const loc = matchLocationIntent(icp, evidenceText, candidate.location);
  if (icp.location && !loc.ok) {
    return {
      ...reject("LOCATION_MISMATCH", "Requested geography not supported", candidate, icp, entityClass),
      requestedLocation: icp.location,
      candidateLocation: loc.candidateLocation,
      locationConfidence: loc.locationConfidence,
      locationEvidence: loc.locationEvidence,
    };
  }

  const industry = matchIndustryIntent(
    icp.industry,
    evidenceText,
    candidate.role,
    candidate.companyName,
  );
  if (icp.industry && !industry.ok) {
    return reject(
      "INDUSTRY_MISMATCH",
      "Requested sector not supported by evidence",
      candidate,
      icp,
      entityClass,
    );
  }

  const idConf = identityConfidenceOf(candidate);
  const companyConf = companyAssociationConfidence({
    companyName: candidate.companyName,
    personName: candidate.personName,
    evidence: candidate.sourceEvidence || [],
  });

  // Instagram-specific searches require a verified/likely Instagram profile
  const wantsIg = icp.preferredNetworks.includes("instagram");
  if (wantsIg && !instagramUrl) {
    return reject("UNVERIFIED_PROFILE", "Instagram profile not verified", candidate, icp, entityClass);
  }

  // Hard identity floor — fit score must never compensate
  if (idConf < 0.55) {
    return reject("IDENTITY_BELOW_GATE", "Identity confidence below hard gate", candidate, icp, entityClass);
  }

  const requireProfile =
    opts?.requireVerifiedProfile ||
    wantsIg ||
    icp.preferredNetworks.includes("linkedin") ||
    icp.preferredNetworks.includes("youtube");

  if (requireProfile && idConf < 0.6) {
    return reject("IDENTITY_BELOW_GATE", "Identity confidence below hard gate", candidate, icp, entityClass);
  }

  if (idConf < 0.55 && (linkedinUrl || instagramUrl || wantsIg)) {
    return reject("IDENTITY_BELOW_GATE", "Identity too weak for clickable prospect", candidate, icp, entityClass);
  }

  if (!candidate.sourceEvidence?.length) {
    return reject("INSUFFICIENT_EVIDENCE", "No source evidence", candidate, icp, entityClass);
  }

  // Dedupe by canonical profile URL
  const profileKey = (instagramUrl || linkedinUrl || "").toLowerCase().replace(/\/$/, "");
  if (profileKey && opts?.seenProfileUrls?.has(profileKey)) {
    return reject("DUPLICATE_PROFILE", "Duplicate canonical profile URL", candidate, icp, entityClass);
  }
  if (profileKey) opts?.seenProfileUrls?.add(profileKey);

  // Company name quality — drop garbled association rather than reject person
  let fit = 0.4 + idConf * 0.35;
  if (role.roleConfidence > 0.7) fit += 0.1;
  if (loc.locationConfidence > 0.7) fit += 0.08;
  if (companyConf >= 0.7) fit += 0.07;
  fit = Math.min(0.95, fit);

  return {
    accepted: true,
    entityClass: entityClass === "UNKNOWN" ? "PERSON" : entityClass,
    requestedRole: icp.role,
    matchedRole: role.matchedRole || candidate.role,
    roleConfidence: role.roleConfidence,
    roleEvidence: role.roleEvidence,
    requestedLocation: icp.location,
    candidateLocation: loc.candidateLocation || candidate.location,
    locationConfidence: loc.locationConfidence,
    locationEvidence: loc.locationEvidence,
    identityConfidence: idConf,
    fitScore: fit,
    companyAssociationConfidence: companyConf,
  };
}

function reject(
  code: RejectionCode,
  reason: string,
  candidate: SocialProspectCandidateInput,
  icp: StructuredIcp,
  entityClass: EntityClass = "UNKNOWN",
): ValidationDecision {
  return {
    accepted: false,
    entityClass,
    rejectionCode: code,
    rejectionReason: reason,
    requestedRole: icp.role,
    matchedRole: candidate.role,
    roleConfidence: 0,
    requestedLocation: icp.location,
    candidateLocation: candidate.location,
    locationConfidence: 0,
    identityConfidence: identityConfidenceOf(candidate),
    fitScore: 0,
    companyAssociationConfidence: 0,
  };
}

/** Whether company evidence is strong enough to create/link a CRM Company. */
export function shouldPersistCompany(input: {
  companyName?: string | null;
  companyWebsite?: string | null;
  evidence?: ProspectEvidence[];
  personName?: string | null;
  associationConfidence?: number;
}): boolean {
  if (!input.companyName || isWeakCompanyName(input.companyName)) return false;
  if (isPersonNameAsCompany(input.companyName, input.personName)) return false;
  const conf =
    input.associationConfidence ??
    companyAssociationConfidence({
      companyName: input.companyName,
      personName: input.personName || undefined,
      evidence: input.evidence || [],
    });
  if (conf < 0.55) return false;
  // Website is strong independent company evidence
  if (input.companyWebsite && !isPersonNameAsCompany(input.companyName, input.personName)) {
    return conf >= 0.55;
  }
  // Without a website, require high association AND a company that does not look like a person headline
  return conf >= 0.75;
}
