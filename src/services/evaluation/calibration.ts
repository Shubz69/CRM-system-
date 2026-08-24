/**
 * Phase 17 — Confidence calibration samples.
 * Record outcomes; report hit-rate by band when samples exist.
 * Do not change confidence models aggressively from sparse data.
 */

import { prisma } from "@/lib/db";
import {
  SIGNAL_EMPIRICAL_PERFORMANCE,
  type LearningSignalKind,
} from "@/services/evaluation/types";

export type CalibrationBandReport = {
  statedBand: string;
  sampleCount: number;
  /** Null when no resolved outcomes (wasCorrect != null) */
  hitRate: number | null;
  correctCount: number;
  resolvedCount: number;
};

export type CalibrationReport = {
  /** Always EMPIRICAL_PERFORMANCE — calibration is measured, not preference */
  signalKind: LearningSignalKind;
  organisationId: string;
  subjectKind?: string;
  totalSamples: number;
  byBand: CalibrationBandReport[];
  /** Honest guidance — sparse data must not drive aggressive model edits */
  recommendation: string;
  maturity: "WORKING";
};

export async function recordConfidenceCalibrationSample(input: {
  organisationId: string;
  subjectKind: string;
  subjectId: string;
  statedBand: string;
  wasCorrect?: boolean | null;
  outcomeKind?: string | null;
  sampleCountHint?: number | null;
}) {
  return prisma.confidenceCalibrationSample.create({
    data: {
      organisationId: input.organisationId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      statedBand: input.statedBand,
      wasCorrect: input.wasCorrect ?? null,
      outcomeKind: input.outcomeKind ?? null,
      sampleCountHint: input.sampleCountHint ?? null,
    },
  });
}

/**
 * Hit-rate by stated confidence band. Bands with zero resolved outcomes → hitRate null.
 */
export async function getCalibrationHitRateByBand(input: {
  organisationId: string;
  subjectKind?: string;
}): Promise<CalibrationReport> {
  const where = {
    organisationId: input.organisationId,
    ...(input.subjectKind ? { subjectKind: input.subjectKind } : {}),
  };

  const rows = await prisma.confidenceCalibrationSample.findMany({
    where,
    select: { statedBand: true, wasCorrect: true },
  });

  const byBandMap = new Map<
    string,
    { sampleCount: number; correctCount: number; resolvedCount: number }
  >();

  for (const r of rows) {
    const cur = byBandMap.get(r.statedBand) ?? {
      sampleCount: 0,
      correctCount: 0,
      resolvedCount: 0,
    };
    cur.sampleCount += 1;
    if (r.wasCorrect != null) {
      cur.resolvedCount += 1;
      if (r.wasCorrect) cur.correctCount += 1;
    }
    byBandMap.set(r.statedBand, cur);
  }

  const byBand: CalibrationBandReport[] = [...byBandMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([statedBand, stats]) => ({
      statedBand,
      sampleCount: stats.sampleCount,
      resolvedCount: stats.resolvedCount,
      correctCount: stats.correctCount,
      hitRate:
        stats.resolvedCount === 0
          ? null
          : stats.correctCount / stats.resolvedCount,
    }));

  const resolvedTotal = byBand.reduce((n, b) => n + b.resolvedCount, 0);
  let recommendation: string;
  if (rows.length === 0) {
    recommendation =
      "No calibration samples yet — do not change confidence models.";
  } else if (resolvedTotal < 20) {
    recommendation =
      "Sparse resolved outcomes — report only; do not aggressively retune confidence models.";
  } else {
    recommendation =
      "Sufficient samples for monitoring; any weight changes must stay within versioned learning boundaries.";
  }

  return {
    signalKind: SIGNAL_EMPIRICAL_PERFORMANCE,
    organisationId: input.organisationId,
    subjectKind: input.subjectKind,
    totalSamples: rows.length,
    byBand,
    recommendation,
    maturity: "WORKING",
  };
}
