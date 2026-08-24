/**
 * Soft bridge into intelligence-quality (Track 5) for trend confidence dimensions.
 * If the quality module is absent or still a stub, return honest nulls — never fake scores.
 */

export type TrendQualityDimensions = {
  sourceQuality: number | null;
  freshness: number | null;
  sampleSize: number | null;
};

export type TrendQualityBridgeResult = {
  available: boolean;
  stub: boolean;
  note: string;
  dimensions: TrendQualityDimensions;
  qualityAssessmentId: string | null;
};

export type TrendQualityBridgeInput = {
  organisationId: string;
  subjectKind: string;
  subjectId: string;
  sampleSize?: number | null;
  sourceCount?: number | null;
  /** Optional ISO freshness hint from caller — not scored here when stubbed. */
  lastObservedAt?: Date | null;
};

type QualityModule = {
  assessTrendConfidenceDimensions?: (
    input: TrendQualityBridgeInput,
  ) => Promise<TrendQualityBridgeResult> | TrendQualityBridgeResult;
  getTrendConfidenceDimensions?: (
    input: TrendQualityBridgeInput,
  ) => Promise<TrendQualityBridgeResult> | TrendQualityBridgeResult;
};

const FALLBACK_NOTE =
  "TODO(Track 5): wire @/services/intelligence-quality for source quality / freshness / sample size. " +
  "Stub returns null dimensions — scores are not fabricated.";

async function tryLoadQualityModule(): Promise<QualityModule | null> {
  try {
    const mod = (await import("@/services/intelligence-quality")) as QualityModule;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Resolve trend confidence dimensions via quality module when present; otherwise stub.
 */
export async function assessTrendQualityBridge(
  input: TrendQualityBridgeInput,
): Promise<TrendQualityBridgeResult> {
  const mod = await tryLoadQualityModule();
  if (mod) {
    const fn = mod.assessTrendConfidenceDimensions ?? mod.getTrendConfidenceDimensions;
    if (typeof fn === "function") {
      const result = await fn(input);
      return {
        available: Boolean(result.available) && !result.stub,
        stub: Boolean(result.stub) || !result.available,
        note: result.note ?? FALLBACK_NOTE,
        dimensions: {
          sourceQuality: result.dimensions?.sourceQuality ?? null,
          freshness: result.dimensions?.freshness ?? null,
          sampleSize: result.dimensions?.sampleSize ?? null,
        },
        qualityAssessmentId: result.qualityAssessmentId ?? null,
      };
    }
  }

  return {
    available: false,
    stub: true,
    note: FALLBACK_NOTE,
    dimensions: {
      sourceQuality: null,
      freshness: null,
      sampleSize: null,
    },
    qualityAssessmentId: null,
  };
}
