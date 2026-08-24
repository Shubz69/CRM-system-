/**
 * Phase 14F — Intelligence Quality verification pipeline (deterministic).
 *
 * retrieve → normalise → extract claims → assess sources → dedupe lineage →
 * corroborate → contradiction search → freshness → relevance → signal quality →
 * optional critic notes → quality gate → result
 *
 * Maturity: WORKING (local/tests). Do not claim LIVE_E2E.
 */

import type { OpportunityQualityGate, VerificationBudget } from "@prisma/client";
import {
  emptyDimensions,
  scoreAuthority,
  scoreCorroboration,
  scoreFreshness,
  scoreIndependence,
  scoreNegativeEvidence,
  scoreRelevance,
  scoreSampleSize,
  scoreSocialQuality,
  scoreSurvivorshipRisk,
  type QualityDimensions,
  type SourceAuthorityInput,
} from "@/services/intelligence-quality/dimensions";
import { applyQualityGate } from "@/services/intelligence-quality/gate";
import {
  claimNormalisedKey,
  hostFromUrl,
  lineageKey,
  normaliseClaimText,
} from "@/services/intelligence-quality/normalise";
import {
  runVerificationAgents,
  type FactVerificationResult,
  type ResearchQualityResult,
  type SocialIntelligenceCriticResult,
} from "@/services/intelligence-quality/agents";
import type {
  ExtractedClaim,
  PipelineFinding,
  RelevanceContext,
  VerificationPipelineInput,
} from "@/services/intelligence-quality/types";

export type {
  ExtractedClaim,
  PipelineFinding,
  RelevanceContext,
  VerificationPipelineInput,
} from "@/services/intelligence-quality/types";

export type VerificationPipelineResult = {
  budget: VerificationBudget;
  findings: PipelineFinding[];
  claims: ExtractedClaim[];
  dimensions: QualityDimensions;
  supportingCount: number;
  contradictingCount: number;
  gateStatus: OpportunityQualityGate;
  criticNotes: string | null;
  escalationReason: string | null;
  consequenceLevel: string;
  agents: {
    fact: FactVerificationResult;
    research: ResearchQualityResult;
    critic: SocialIntelligenceCriticResult;
  };
  /** Explicit marker — dimensions are heuristics, not calibrated %. */
  calibrationNote: "transparent_heuristics_not_calibrated_percentages";
};

function inferAuthorityTier(f: PipelineFinding): SourceAuthorityInput["tier"] {
  if (f.authorityTier) return f.authorityTier;
  const p = (f.providerKey ?? f.platform ?? "").toLowerCase();
  if (p === "crm" || p === "twin" || p === "first_party") return "first_party";
  if (["manychat", "instagram", "linkedin", "tiktok", "youtube", "booking"].includes(p)) {
    return "connected_api";
  }
  if (["tavily", "exa", "web", "indexed_web"].includes(p)) return "indexed_web";
  if (["apify", "twitter", "x", "reddit", "social"].includes(p)) return "social_ugc";
  if (f.platform && /instagram|tiktok|twitter|x|linkedin|youtube/i.test(f.platform)) {
    return "social_ugc";
  }
  return "unknown";
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normaliseClaimText(text)
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function keywordOverlap(text: string, keywords: string[] | undefined): number {
  if (!keywords?.length) return 0;
  const tokens = tokenSet(text);
  let hits = 0;
  for (const kw of keywords) {
    const n = normaliseClaimText(kw);
    if (!n) continue;
    if (tokens.has(n) || [...tokens].some((t) => t.includes(n) || n.includes(t))) {
      hits += 1;
    }
  }
  return hits;
}

function isNegatedPair(a: string, b: string): boolean {
  const na = normaliseClaimText(a);
  const nb = normaliseClaimText(b);
  if (na === nb) return false;
  const aNeg = /\b(not|no|never|false|incorrect|debunked)\b/.test(na);
  const bNeg = /\b(not|no|never|false|incorrect|debunked)\b/.test(nb);
  if (aNeg === bNeg) return false;
  const ta = tokenSet(na);
  const tb = tokenSet(nb);
  let shared = 0;
  for (const t of ta) {
    if (tb.has(t) && !["not", "never", "false"].includes(t)) shared += 1;
  }
  return shared >= 2;
}

/**
 * Full deterministic verification pipeline.
 */
export function runVerificationPipeline(
  input: VerificationPipelineInput,
): VerificationPipelineResult {
  const budget = input.budget ?? "STANDARD";
  const now = input.now ?? new Date();
  const findings = input.findings ?? [];
  const relevance: RelevanceContext = input.relevance ?? {};

  // 1–2. Retrieve (caller) → normalise + extract claims
  const claimMap = new Map<string, ExtractedClaim>();

  findings.forEach((f, findingIndex) => {
    const text = (f.claimText || f.evidenceExcerpt || "").trim();
    if (!text) return;
    const normalisedText = normaliseClaimText(text);
    const normalisedKey = claimNormalisedKey(text);
    const host = hostFromUrl(f.sourceUrl);
    const lineage = lineageKey({
      providerKey: f.providerKey ?? f.platform,
      host,
      accountRef: f.author,
    });
    const supports = f.supports !== false;

    let claim = claimMap.get(normalisedKey);
    if (!claim) {
      claim = {
        text,
        normalisedText,
        normalisedKey,
        claimKind: (f.claimKind ?? "FACT").toUpperCase(),
        status: "EXTRACTED",
        supportingCount: 0,
        contradictingCount: 0,
        uniqueLineages: 0,
        evidence: [],
        dimensions: emptyDimensions(),
      };
      claimMap.set(normalisedKey, claim);
    }

    claim.evidence.push({
      findingIndex,
      lineage,
      supports,
      researchFindingId: f.researchFindingId,
      researchSourceId: f.researchSourceId,
      researchSnapshotId: f.researchSnapshotId,
      providerKey: f.providerKey ?? f.platform,
      sourceUrl: f.sourceUrl,
      retrievedAt: f.retrievedAt ?? f.publishedAt ?? null,
      excerpt: f.evidenceExcerpt ?? null,
    });
  });

  // Cross-claim contradiction search (negated near-duplicates)
  const claimsList = [...claimMap.values()];
  for (let i = 0; i < claimsList.length; i++) {
    for (let j = i + 1; j < claimsList.length; j++) {
      if (isNegatedPair(claimsList[i]!.text, claimsList[j]!.text)) {
        claimsList[i]!.contradictingCount += 1;
        claimsList[j]!.contradictingCount += 1;
      }
    }
  }

  // 3–10. Per-claim assess → dedupe lineage → corroborate → freshness → relevance → signal
  for (const claim of claimsList) {
    const supporting = claim.evidence.filter((e) => e.supports);
    const contradicting = claim.evidence.filter((e) => !e.supports);
    claim.supportingCount = supporting.length;
    claim.contradictingCount += contradicting.length;

    const uniqueLineages = new Set(supporting.map((e) => e.lineage));
    claim.uniqueLineages = uniqueLineages.size;

    const sourceFindings = claim.evidence
      .map((e) => findings[e.findingIndex])
      .filter((f): f is PipelineFinding => Boolean(f));

    const authorityScores = sourceFindings.map((f) =>
      scoreAuthority({
        tier: inferAuthorityTier(f),
        https: Boolean(f.sourceUrl?.startsWith("https://")),
      }),
    );
    const authority =
      authorityScores.length > 0
        ? authorityScores.reduce((a, b) => a + b, 0) / authorityScores.length
        : 0.2;

    const retrievedDates = claim.evidence
      .map((e) => e.retrievedAt)
      .filter((d): d is Date => d instanceof Date);
    const newest = retrievedDates.sort((a, b) => b.getTime() - a.getTime())[0];
    const freshness = scoreFreshness(newest, now);

    const corroboration = scoreCorroboration(uniqueLineages.size, supporting.length);
    const independence = scoreIndependence(uniqueLineages.size, supporting.length);

    const audienceHits = keywordOverlap(claim.text, relevance.audienceKeywords);
    const audienceRelevance = relevance.audienceKeywords?.length
      ? scoreRelevance(audienceHits, Math.min(2, relevance.audienceKeywords.length))
      : 0.5;

    const platforms = new Set(
      sourceFindings.map((f) => (f.platform ?? "").toLowerCase()).filter(Boolean),
    );
    let platformHits = 0;
    if (relevance.targetPlatforms?.length) {
      for (const tp of relevance.targetPlatforms) {
        if (platforms.has(tp.toLowerCase())) platformHits += 1;
      }
    }
    const platformRelevance = relevance.targetPlatforms?.length
      ? scoreRelevance(platformHits, 1)
      : 0.5;

    const geoBlob = sourceFindings
      .map((f) => `${f.claimText} ${f.evidenceExcerpt ?? ""}`)
      .join(" ");
    const geoHits = keywordOverlap(geoBlob, relevance.targetGeos);
    const geoRelevance = relevance.targetGeos?.length
      ? scoreRelevance(geoHits, 1)
      : 0.5;

    const samples = sourceFindings
      .map((f) => f.sampleSize)
      .filter((n): n is number => typeof n === "number" && n > 0);
    const sampleSize = scoreSampleSize(
      samples.length ? Math.max(...samples) : supporting.length > 0 ? supporting.length : null,
    );

    const socialScores = sourceFindings.map((f) => {
      const eng = f.engagement;
      const engagementSum =
        (eng?.likes ?? 0) + (eng?.comments ?? 0) + (eng?.shares ?? 0);
      return scoreSocialQuality({
        views: eng?.views,
        engagements: engagementSum > 0 ? engagementSum : undefined,
        followers: eng?.followers,
        ageHours: f.retrievedAt
          ? (now.getTime() - f.retrievedAt.getTime()) / 3_600_000
          : null,
      });
    });
    const socialQuality =
      socialScores.length > 0
        ? socialScores.reduce((a, b) => a + b, 0) / socialScores.length
        : 0.2;

    const onlyWinners =
      contradicting.length === 0 &&
      supporting.length > 0 &&
      /success|winner|best|#1|top\b/i.test(claim.text);
    const survivorshipRisk = scoreSurvivorshipRisk(
      onlyWinners,
      contradicting.length === 0 && onlyWinners,
    );
    const negativeEvidence = scoreNegativeEvidence(contradicting.length, supporting.length);

    claim.dimensions = {
      authority,
      freshness,
      corroboration,
      independence,
      audienceRelevance,
      platformRelevance,
      geoRelevance,
      sampleSize,
      socialQuality,
      survivorshipRisk,
      negativeEvidence,
    };

    if (claim.contradictingCount > 0 && claim.contradictingCount >= claim.supportingCount) {
      claim.status = "CONFLICTED";
    } else if (claim.supportingCount === 0) {
      claim.status = "INSUFFICIENT";
    } else if (uniqueLineages.size >= 2 && claim.contradictingCount === 0) {
      claim.status = "CORROBORATED";
    } else if (claim.supportingCount >= 1) {
      claim.status = "EXTRACTED";
    } else {
      claim.status = "REJECTED";
    }
  }

  let dimensions: QualityDimensions;
  let supportingCount = 0;
  let contradictingCount = 0;

  if (claimsList.length === 0) {
    dimensions = emptyDimensions({ corroboration: 0, independence: 0, freshness: 0.25 });
  } else {
    const keys = Object.keys(emptyDimensions()) as (keyof QualityDimensions)[];
    const acc = emptyDimensions({
      authority: 0,
      freshness: 0,
      corroboration: 0,
      independence: 0,
      audienceRelevance: 0,
      platformRelevance: 0,
      geoRelevance: 0,
      sampleSize: 0,
      socialQuality: 0,
      survivorshipRisk: 0,
      negativeEvidence: 0,
    });
    for (const c of claimsList) {
      supportingCount += c.supportingCount;
      contradictingCount += c.contradictingCount;
      for (const k of keys) {
        acc[k] += c.dimensions[k];
      }
    }
    const n = claimsList.length;
    dimensions = emptyDimensions();
    for (const k of keys) {
      dimensions[k] = acc[k] / n;
    }
  }

  const agents = runVerificationAgents({
    claims: claimsList,
    findings,
    dimensions,
    budget,
    contradictingCount,
    supportingCount,
    llmCriticNotes: input.llmCriticNotes,
  });

  // Gate is authoritative — recompute explicitly (agents also compute for symmetry).
  const gateStatus = applyQualityGate({
    dimensions,
    budget,
    contradictingCount,
    supportingCount,
  });

  let escalationReason: string | null = null;
  if (gateStatus === "CONFLICTED") {
    escalationReason = "Conflicting evidence lineages require human review.";
  } else if (gateStatus === "STALE") {
    escalationReason = "Evidence freshness below budget threshold.";
  } else if (gateStatus === "INSUFFICIENT_EVIDENCE") {
    escalationReason = "Insufficient supporting evidence for this budget.";
  } else if (gateStatus === "NEEDS_MORE_RESEARCH") {
    escalationReason = "Dimensions below pass thresholds — more independent sources needed.";
  } else if (gateStatus === "REJECTED") {
    escalationReason = "Assessment rejected.";
  }

  return {
    budget,
    findings,
    claims: claimsList,
    dimensions,
    supportingCount,
    contradictingCount,
    gateStatus,
    criticNotes: agents.critic.criticNotes || null,
    escalationReason,
    consequenceLevel: input.consequenceLevel ?? "MEDIUM",
    agents: {
      fact: agents.fact,
      research: agents.research,
      critic: agents.critic,
    },
    calibrationNote: "transparent_heuristics_not_calibrated_percentages",
  };
}
