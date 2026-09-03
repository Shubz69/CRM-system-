import type {
  ProspectEvidence,
  SocialNetworkId,
  SocialProfileIdentity,
  SocialProspectCandidateInput,
  StructuredIcp,
} from "@/services/social-prospecting/types";
import {
  buildProspectDedupeKey,
  normalizeInstagramUrl,
  normalizeLinkedInUrl,
} from "@/services/social-prospecting/types";
import { resolveIdentitiesForCandidate, applyIdentitiesToCandidate } from "@/services/social-prospecting/identity-resolver";
import {
  isWeakCompanyName,
  validateProspectCandidate,
  type RejectionCode,
  type ValidationDecision,
} from "@/services/social-prospecting/entity-validation";

export type ProspectFitDimensions = {
  identityConfidence: number;
  roleMatch: number;
  companyMatch: number;
  geographyMatch: number;
  industryMatch: number;
  sizeMatch: number;
  intentSignal: number;
  overallFit: number;
};

export type QualityResult = {
  ok: boolean;
  candidate: SocialProspectCandidateInput;
  uncertaintyFlags: string[];
  reasonSelected: string;
  confidence: number;
  /** Commercial fit — must not override identity gates */
  fitScore: number;
  identityConfidence: number;
  /** Explicit dimension scores — missing evidence never scores 100%. */
  fitDimensions: ProspectFitDimensions;
  validation: ValidationDecision;
  rejectionCode?: RejectionCode;
};

/** Build transparent fit dimensions — missing evidence stays low, never 100%. */
export function buildProspectFitDimensions(input: {
  identityConfidence: number;
  roleConfidence: number;
  locationConfidence: number;
  companyAssociationConfidence: number;
  industryMatch?: number | null;
  sizeMatch?: number | null;
  intentSignal?: number | null;
  fitScore: number;
}): ProspectFitDimensions {
  const pct = (n: number) => Math.max(0, Math.min(95, Math.round(n * 100)));
  const identity = pct(input.identityConfidence);
  const role = pct(input.roleConfidence);
  const company = pct(input.companyAssociationConfidence);
  const geography = pct(input.locationConfidence);
  const industry =
    input.industryMatch == null ? 0 : pct(input.industryMatch);
  const size = input.sizeMatch == null ? 0 : pct(input.sizeMatch);
  const intent = input.intentSignal == null ? 0 : pct(input.intentSignal);
  const overall = Math.min(
    95,
    Math.round(
      identity * 0.25 +
        role * 0.2 +
        company * 0.15 +
        geography * 0.15 +
        industry * 0.1 +
        size * 0.05 +
        intent * 0.1,
    ),
  );
  // Cap overall by identity — never treat missing identity as high fit
  const cappedOverall = Math.min(overall, identity + 15, pct(input.fitScore));
  return {
    identityConfidence: identity,
    roleMatch: role,
    companyMatch: company,
    geographyMatch: geography,
    industryMatch: industry,
    sizeMatch: size,
    intentSignal: intent,
    overallFit: cappedOverall,
  };
}

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

const DEFAULT_ICP: StructuredIcp = {
  entityType: "person",
  signals: [],
  keywords: [],
  exclusions: [],
  preferredNetworks: ["any"],
  desiredCount: 10,
  rawQuery: "",
};

/**
 * Deduplicate + validate before presenting a prospect.
 * Hard identity gates cannot be compensated by commercial fit.
 */
export function qualityCheckProspect(
  input: SocialProspectCandidateInput,
  seenDedupeKeys: Set<string>,
  icp: StructuredIcp = DEFAULT_ICP,
  seenProfileUrls?: Set<string>,
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

  if (candidate.companyName && isWeakCompanyName(candidate.companyName)) {
    candidate = { ...candidate, companyName: undefined };
  }

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
    candidate = applyIdentitiesToCandidate(candidate, candidate.socialIdentities);
  }

  const linkedinUrl = normalizeLinkedInUrl(candidate.linkedinUrl);
  const instagramUrl = normalizeInstagramUrl(candidate.instagramUrl);
  candidate = { ...candidate, linkedinUrl, instagramUrl };

  if (!candidate.personName && !candidate.companyName) return null;
  if (!candidate.sourceEvidence.length) return null;

  const dedupeKey = buildProspectDedupeKey(candidate);
  if (seenDedupeKeys.has(dedupeKey)) {
    return null;
  }

  const validation = validateProspectCandidate(candidate, icp, {
    seenProfileUrls: seenProfileUrls || new Set(),
  });

  if (!validation.accepted) {
    return {
      ok: false,
      candidate,
      uncertaintyFlags: [validation.rejectionCode || "REJECTED"],
      reasonSelected: validation.rejectionReason || "Rejected",
      confidence: validation.identityConfidence,
      fitScore: 0,
      identityConfidence: validation.identityConfidence,
      fitDimensions: buildProspectFitDimensions({
        identityConfidence: validation.identityConfidence,
        roleConfidence: validation.roleConfidence,
        locationConfidence: validation.locationConfidence,
        companyAssociationConfidence: validation.companyAssociationConfidence,
        fitScore: 0,
      }),
      validation,
      rejectionCode: validation.rejectionCode,
    };
  }

  seenDedupeKeys.add(dedupeKey);

  // Drop weak company association from persisted fields
  if (validation.companyAssociationConfidence < 0.55) {
    candidate = { ...candidate, companyName: undefined, companyWebsite: undefined };
  } else if (validation.matchedRole) {
    candidate = {
      ...candidate,
      role: validation.matchedRole,
      location: validation.candidateLocation || candidate.location,
    };
  }

  const uncertaintyFlags: string[] = [...(candidate.uncertaintyFlags || [])];
  if (validation.companyAssociationConfidence > 0 && validation.companyAssociationConfidence < 0.7) {
    uncertaintyFlags.push("company_association_uncertain");
  }

  let confidence = Math.min(
    evidenceStrength(candidate.sourceEvidence) + identityBoost(candidate.socialIdentities),
    validation.identityConfidence + 0.15,
  );
  confidence = Math.min(confidence, validation.identityConfidence + 0.2);
  if (uncertaintyFlags.length) confidence = Math.min(confidence, 0.7);

  const fitScore = Math.min(validation.fitScore, 0.95);
  // Never let fit exceed identity by a large margin for presentation ranking
  const presentationFit = Math.min(fitScore, validation.identityConfidence + 0.25);

  const verifiedCount =
    candidate.socialIdentities?.filter(
      (i) => i.verificationState === "VERIFIED" || i.verificationState === "LIKELY",
    ).length || 0;

  const reasonSelected =
    candidate.reasonSelected?.trim() ||
    [
      validation.matchedRole ? `Role evidence: ${validation.matchedRole}` : null,
      candidate.companyName ? `Company: ${candidate.companyName}` : null,
      validation.candidateLocation ? `Location evidence: ${validation.candidateLocation}` : null,
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
      fitScore: presentationFit,
      reasonSelected,
      uncertaintyFlags: [...new Set(uncertaintyFlags)],
      qaDecision: {
        accepted: true,
        entityClass: validation.entityClass,
        requestedRole: validation.requestedRole,
        matchedRole: validation.matchedRole,
        roleConfidence: validation.roleConfidence,
        requestedLocation: validation.requestedLocation,
        candidateLocation: validation.candidateLocation,
        locationConfidence: validation.locationConfidence,
        identityConfidence: validation.identityConfidence,
        companyAssociationConfidence: validation.companyAssociationConfidence,
      },
    },
    uncertaintyFlags: [...new Set(uncertaintyFlags)],
    reasonSelected,
    confidence,
    fitScore: presentationFit,
    identityConfidence: validation.identityConfidence,
    fitDimensions: buildProspectFitDimensions({
      identityConfidence: validation.identityConfidence,
      roleConfidence: validation.roleConfidence,
      locationConfidence: validation.locationConfidence,
      companyAssociationConfidence: validation.companyAssociationConfidence,
      fitScore: presentationFit,
    }),
    validation,
  };
}

export function dedupeProspectBatch(
  inputs: SocialProspectCandidateInput[],
  icp?: StructuredIcp,
): { accepted: QualityResult[]; rejected: QualityResult[] } {
  const seen = new Set<string>();
  const seenProfiles = new Set<string>();
  const accepted: QualityResult[] = [];
  const rejected: QualityResult[] = [];
  for (const input of inputs) {
    const checked = qualityCheckProspect(input, seen, icp || DEFAULT_ICP, seenProfiles);
    if (!checked) continue;
    if (checked.ok) accepted.push(checked);
    else rejected.push(checked);
  }
  accepted.sort((a, b) => b.fitScore - a.fitScore);
  return { accepted, rejected };
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
