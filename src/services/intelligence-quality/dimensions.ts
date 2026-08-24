/**
 * Phase 14F — transparent dimension scores (0–1).
 * These are deterministic heuristics, NOT calibrated probabilities.
 * Do not present as “87% confidence” without empirical calibration samples.
 */

export type QualityDimensions = {
  authority: number;
  freshness: number;
  corroboration: number;
  independence: number;
  audienceRelevance: number;
  platformRelevance: number;
  geoRelevance: number;
  sampleSize: number;
  socialQuality: number;
  /** Higher = more survivorship risk (worse). */
  survivorshipRisk: number;
  /** Higher = more negative/contradicting evidence found. */
  negativeEvidence: number;
};

export type SourceAuthorityInput = {
  /** Known catalogue provider / first-party twin / peer-reviewed-ish. */
  tier: "first_party" | "connected_api" | "indexed_web" | "social_ugc" | "unknown";
  https: boolean;
};

/** Authority: tier ladder + https bonus. Max 1.0 */
export function scoreAuthority(s: SourceAuthorityInput): number {
  const tierScore =
    s.tier === "first_party"
      ? 0.95
      : s.tier === "connected_api"
        ? 0.8
        : s.tier === "indexed_web"
          ? 0.55
          : s.tier === "social_ugc"
            ? 0.35
            : 0.2;
  return clamp01(tierScore + (s.https ? 0.05 : 0));
}

/** Freshness: half-life style decay from retrievedAt / publishedAt. */
export function scoreFreshness(retrievedAt: Date | null | undefined, now = new Date()): number {
  if (!retrievedAt) return 0.25;
  const ageDays = Math.max(0, (now.getTime() - retrievedAt.getTime()) / 86_400_000);
  if (ageDays <= 1) return 1;
  if (ageDays <= 7) return 0.85;
  if (ageDays <= 30) return 0.65;
  if (ageDays <= 90) return 0.4;
  if (ageDays <= 365) return 0.2;
  return 0.05;
}

/**
 * Corroboration: independent supporting lineages / total supporting.
 * 0 supporting → 0; 1 → 0.4; 2+ independent → up to 1.
 */
export function scoreCorroboration(independentSupporting: number, totalSupporting: number): number {
  if (totalSupporting <= 0) return 0;
  if (independentSupporting <= 0) return 0.15;
  if (independentSupporting === 1) return 0.4;
  if (independentSupporting === 2) return 0.75;
  return 1;
}

/** Independence: unique lineage keys among supporting evidence. */
export function scoreIndependence(uniqueLineages: number, evidenceCount: number): number {
  if (evidenceCount <= 0) return 0;
  return clamp01(uniqueLineages / Math.max(evidenceCount, 1));
}

export function scoreRelevance(overlap: number, required = 1): number {
  if (required <= 0) return 0.5;
  return clamp01(overlap / required);
}

/** Sample size awareness — tiny n → low score. */
export function scoreSampleSize(n: number | null | undefined): number {
  if (n == null || n <= 0) return 0.2;
  if (n < 5) return 0.3;
  if (n < 20) return 0.5;
  if (n < 100) return 0.75;
  return 0.95;
}

/**
 * Social signal quality — penalise engagement without base audience / age context.
 */
export function scoreSocialQuality(input: {
  views?: number | null;
  engagements?: number | null;
  followers?: number | null;
  ageHours?: number | null;
}): number {
  const views = input.views ?? 0;
  const eng = input.engagements ?? 0;
  const followers = input.followers ?? 0;
  if (views <= 0 && eng <= 0) return 0.2;
  let score = 0.4;
  if (followers > 0 && views > 0) {
    const rate = views / Math.max(followers, 1);
    score = rate > 2 ? 0.85 : rate > 0.5 ? 0.7 : rate > 0.1 ? 0.55 : 0.35;
  }
  if ((input.ageHours ?? 999) < 6 && views > 10_000 && followers < 500) {
    // Possible anomalous spike — lower quality until corroborated.
    score = Math.min(score, 0.35);
  }
  return clamp01(score);
}

export function scoreSurvivorshipRisk(onlyWinnersVisible: boolean, missingFailures: boolean): number {
  let risk = 0.2;
  if (onlyWinnersVisible) risk += 0.4;
  if (missingFailures) risk += 0.3;
  return clamp01(risk);
}

export function scoreNegativeEvidence(contradicting: number, supporting: number): number {
  if (contradicting <= 0) return 0;
  return clamp01(contradicting / Math.max(supporting + contradicting, 1));
}

export function averageDimensions(d: QualityDimensions): number {
  const positive =
    (d.authority +
      d.freshness +
      d.corroboration +
      d.independence +
      d.audienceRelevance +
      d.platformRelevance +
      d.geoRelevance +
      d.sampleSize +
      d.socialQuality) /
    9;
  const penalty = d.survivorshipRisk * 0.25 + d.negativeEvidence * 0.35;
  return clamp01(positive - penalty);
}

export function emptyDimensions(partial?: Partial<QualityDimensions>): QualityDimensions {
  return {
    authority: 0.2,
    freshness: 0.25,
    corroboration: 0,
    independence: 0,
    audienceRelevance: 0.5,
    platformRelevance: 0.5,
    geoRelevance: 0.5,
    sampleSize: 0.2,
    socialQuality: 0.2,
    survivorshipRisk: 0.2,
    negativeEvidence: 0,
    ...partial,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
