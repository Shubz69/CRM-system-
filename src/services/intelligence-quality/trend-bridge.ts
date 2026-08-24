/**
 * Soft bridge for Phase 16 continuous-intelligence / quality-bridge.
 * Uses real dimension helpers when sample/freshness signals exist — never invents %.
 */

import { scoreFreshness, scoreSampleSize } from "@/services/intelligence-quality/dimensions";

/** Local shape — avoid circular import with quality-bridge. */
export type AssessTrendConfidenceInput = {
  organisationId: string;
  subjectKind: string;
  subjectId: string;
  sampleSize?: number | null;
  sourceCount?: number | null;
  lastObservedAt?: Date | null;
};

/**
 * Lightweight trend confidence dimensions from observable inputs only.
 * Full opportunity verification lives in verifyBusinessOpportunity / pipeline.
 */
export async function assessTrendConfidenceDimensions(input: AssessTrendConfidenceInput) {
  const hasSignal =
    input.sampleSize != null || input.sourceCount != null || input.lastObservedAt != null;
  if (!hasSignal) {
    return {
      available: false,
      stub: false,
      note: "No observable sample/freshness signals — dimensions withheld (not fabricated).",
      dimensions: {
        sourceQuality: null as number | null,
        freshness: null as number | null,
        sampleSize: null as number | null,
      },
      qualityAssessmentId: null as string | null,
    };
  }

  const sampleSize = scoreSampleSize(input.sampleSize ?? input.sourceCount);
  const freshness = scoreFreshness(input.lastObservedAt ?? null);
  // sourceQuality: independent source count ladder (0–1), not a calibrated probability.
  const n = input.sourceCount ?? 0;
  const sourceQuality = n <= 0 ? 0.15 : n === 1 ? 0.4 : n === 2 ? 0.7 : 0.9;

  return {
    available: true,
    stub: false,
    note: "Transparent heuristics from sampleSize/sourceCount/lastObservedAt — not calibrated %.",
    dimensions: {
      sourceQuality,
      freshness,
      sampleSize,
    },
    qualityAssessmentId: null as string | null,
  };
}

export const getTrendConfidenceDimensions = assessTrendConfidenceDimensions;
