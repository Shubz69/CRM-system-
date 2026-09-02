import type {
  ProspectEvidence,
  SocialNetworkId,
  SocialProfileIdentity,
  SocialProspectCandidateInput,
} from "@/services/social-prospecting/types";
import {
  buildProspectDedupeKey,
  normalizeInstagramUrl,
  normalizeLinkedInUrl,
} from "@/services/social-prospecting/types";
import { resolveIdentitiesForCandidate, applyIdentitiesToCandidate } from "@/services/social-prospecting/identity-resolver";

export type QualityResult = {
  ok: boolean;
  candidate: SocialProspectCandidateInput;
  uncertaintyFlags: string[];
  reasonSelected: string;
  confidence: number;
  fitScore: number;
};

function evidenceStrength(evidence: ProspectEvidence[]): number {
  if (!evidence.length) return 0;
  let score = Math.min(0.55, evidence.length * 0.15);
  for (const e of evidence) {
    if (e.url) score += 0.08;
    if ((e.excerpt || "").length > 40) score += 0.05;
  }
  return Math.min(0.95, score);
}

function identityBoost(identities?: SocialProfileIdentity[]): number {
  if (!identities?.length) return 0;
  if (identities.some((i) => i.verificationState === "VERIFIED")) return 0.08;
  if (identities.some((i) => i.verificationState === "LIKELY")) return 0.04;
  return 0;
}

/**
 * Deduplicate + validate before presenting a prospect.
 * Never invent missing values. High confidence requires supporting evidence.
 * Unverified profile URLs are not shown as exact links.
 */
export function qualityCheckProspect(
  input: SocialProspectCandidateInput,
  seenDedupeKeys: Set<string>,
): QualityResult | null {
  let candidate: SocialProspectCandidateInput = {
    ...input,
    personName: input.personName?.trim() || undefined,
    companyName: input.companyName?.trim() || undefined,
    role: input.role?.trim() || undefined,
    companyWebsite: input.companyWebsite?.trim() || undefined,
    location: input.location?.trim() || undefined,
    sourceEvidence: Array.isArray(input.sourceEvidence) ? input.sourceEvidence : [],
  };

  if (!candidate.socialIdentities?.length) {
    const identities = resolveIdentitiesForCandidate({
      personName: candidate.personName,
      companyName: candidate.companyName,
      role: candidate.role,
      location: candidate.location,
      sourceResults: [],
      extraUrls: [
        candidate.linkedinUrl,
        candidate.instagramUrl,
        ...(candidate.otherSocialUrls || []),
      ].filter(Boolean) as string[],
    });
    candidate = applyIdentitiesToCandidate(candidate, identities);
  } else {
    // Re-apply so only VERIFIED/LIKELY become display URLs
    candidate = applyIdentitiesToCandidate(candidate, candidate.socialIdentities);
  }

  const linkedinUrl = normalizeLinkedInUrl(candidate.linkedinUrl);
  const instagramUrl = normalizeInstagramUrl(candidate.instagramUrl);
  candidate = { ...candidate, linkedinUrl, instagramUrl };

  if (!candidate.personName && !candidate.companyName) return null;
  if (!candidate.sourceEvidence.length) return null;

  const dedupeKey = buildProspectDedupeKey(candidate);
  if (seenDedupeKeys.has(dedupeKey)) return null;
  seenDedupeKeys.add(dedupeKey);

  const uncertaintyFlags: string[] = [...(candidate.uncertaintyFlags || [])];

  if (candidate.personName && candidate.companyName) {
    const personInEvidence = candidate.sourceEvidence.some((e) =>
      (e.excerpt || "").toLowerCase().includes(candidate.personName!.toLowerCase().split(" ")[0] || ""),
    );
    if (!personInEvidence) uncertaintyFlags.push("person_company_relationship_unverified");
  }

  if (linkedinUrl && candidate.personName) {
    const slug = linkedinUrl.toLowerCase();
    const first = candidate.personName.toLowerCase().split(/\s+/)[0];
    if (first && first.length > 2 && !slug.includes(first) && !/\/company\//.test(slug)) {
      uncertaintyFlags.push("linkedin_url_name_mismatch");
      // Drop wrong-profile LinkedIn from presentation
      candidate = { ...candidate, linkedinUrl: undefined };
      uncertaintyFlags.push("profile_not_verified");
    }
  }

  const conflicting = candidate.sourceEvidence.filter((a, i) =>
    candidate.sourceEvidence.some(
      (b, j) =>
        i < j && a.url && b.url && a.url !== b.url && (a.excerpt || "") && (b.excerpt || "") && a.excerpt !== b.excerpt,
    ),
  );
  if (conflicting.length > 2) uncertaintyFlags.push("conflicting_sources");

  let confidence = evidenceStrength(candidate.sourceEvidence) + identityBoost(candidate.socialIdentities);
  if (uncertaintyFlags.includes("profile_not_verified") || uncertaintyFlags.includes("conflicting_social_identities")) {
    confidence = Math.min(confidence, 0.5);
  }
  if (uncertaintyFlags.length) confidence = Math.min(confidence, 0.55);
  if (candidate.sourceEvidence.length < 2) confidence = Math.min(confidence, 0.5);

  if (confidence >= 0.75 && candidate.sourceEvidence.length < 2) {
    confidence = 0.6;
    uncertaintyFlags.push("confidence_capped_insufficient_evidence");
  }

  let fitScore = confidence;
  if (candidate.role) fitScore += 0.05;
  if (candidate.location) fitScore += 0.03;
  if (linkedinUrl || instagramUrl) fitScore += 0.05;
  fitScore = Math.min(0.95, fitScore);

  const verifiedCount =
    candidate.socialIdentities?.filter((i) => i.verificationState === "VERIFIED" || i.verificationState === "LIKELY")
      .length || 0;

  const reasonSelected =
    candidate.reasonSelected?.trim() ||
    [
      candidate.role ? `Role matches ICP (${candidate.role})` : null,
      candidate.companyName ? `Company: ${candidate.companyName}` : null,
      candidate.location ? `Location: ${candidate.location}` : null,
      verifiedCount ? `${verifiedCount} social profile(s) evidence-backed` : "Social profiles not verified",
      `Supported by ${candidate.sourceEvidence.length} evidence source(s)`,
    ]
      .filter(Boolean)
      .join(". ") ||
    "Selected from research evidence";

  return {
    ok: true,
    candidate: {
      ...candidate,
      confidence,
      fitScore,
      reasonSelected,
      uncertaintyFlags: [...new Set(uncertaintyFlags)],
    },
    uncertaintyFlags: [...new Set(uncertaintyFlags)],
    reasonSelected,
    confidence,
    fitScore,
  };
}

export function dedupeProspectBatch(inputs: SocialProspectCandidateInput[]): QualityResult[] {
  const seen = new Set<string>();
  const out: QualityResult[] = [];
  for (const input of inputs) {
    const checked = qualityCheckProspect(input, seen);
    if (checked) out.push(checked);
  }
  return out.sort((a, b) => b.fitScore - a.fitScore);
}

export function displayProfileLabel(identity: SocialProfileIdentity): string {
  if (identity.verificationState === "VERIFIED" || identity.verificationState === "LIKELY") {
    return identity.canonicalProfileUrl;
  }
  return "Profile not verified";
}

export function networksWithVerifiedProfiles(
  identities?: SocialProfileIdentity[],
): SocialNetworkId[] {
  return (identities || [])
    .filter((i) => i.verificationState === "VERIFIED" || i.verificationState === "LIKELY")
    .map((i) => i.network);
}
