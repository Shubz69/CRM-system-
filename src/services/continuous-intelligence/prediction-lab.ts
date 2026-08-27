/**
 * Prediction Lab — WORKING for create/list/score-when-outcome-present path.
 * Accuracy / calibrated hit-rate remains FOUNDATION until scored sample volume exists.
 */

import { Prisma, PredictionEvaluationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assessTrendQualityBridge } from "@/services/continuous-intelligence/quality-bridge";

export const PREDICTION_LAB_MODEL_VERSION = "rules-v1";

export const PREDICTION_LAB_DISCLAIMER =
  "WORKING recording path; FOUNDATION accuracy — feature-derived heuristics with transparent confidence bands. " +
  "Do not claim accurate virality or calibrated probability without scored backtest samples.";

export type ConfidenceBand = "LOW" | "MEDIUM" | "HIGH" | "INSUFFICIENT";

export type PredictionFeatures = Record<string, unknown> & {
  velocity?: number;
  acceleration?: number;
  mentionCount?: number;
  crossPlatformCount?: number;
  normalisedComposite?: number | null;
  sampleSize?: number;
  lifecycleLabel?: string;
};

export function deriveConfidenceBand(features: PredictionFeatures): {
  band: ConfidenceBand;
  reasons: string[];
} {
  const reasons: string[] = [];
  const sampleSize = typeof features.sampleSize === "number" ? features.sampleSize : 0;
  const cross =
    typeof features.crossPlatformCount === "number" ? features.crossPlatformCount : 0;
  const mentions = typeof features.mentionCount === "number" ? features.mentionCount : 0;
  const hasNorm =
    features.normalisedComposite != null && Number.isFinite(Number(features.normalisedComposite));

  if (sampleSize < 2 && mentions < 3) {
    reasons.push("Sparse observables (sampleSize < 2 and low mentions)");
    return { band: "INSUFFICIENT", reasons };
  }
  if (sampleSize < 3 || cross < 2) {
    reasons.push("Limited history or single-platform signal → LOW band");
    return { band: "LOW", reasons };
  }
  if (sampleSize >= 8 && cross >= 2 && mentions >= 10 && hasNorm) {
    reasons.push("Richer history + multi-platform + normalisation context → HIGH band (still uncalibrated)");
    return { band: "HIGH", reasons };
  }
  reasons.push("Moderate observables → MEDIUM band (transparent, not calibrated)");
  return { band: "MEDIUM", reasons };
}

export async function createIntelligencePrediction(input: {
  organisationId: string;
  predictionType: string;
  statement: string;
  horizonAt: Date;
  features: PredictionFeatures;
  modelVersion?: string;
  expectedOutcome?: Record<string, unknown>;
  trendClusterId?: string | null;
  /** When true, soft-call quality bridge and attach note into features (no fake scores). */
  includeQualityBridge?: boolean;
}) {
  const band = deriveConfidenceBand(input.features);
  let features: PredictionFeatures = {
    ...input.features,
    confidenceReasons: band.reasons,
    disclaimer: PREDICTION_LAB_DISCLAIMER,
  };

  let qualityAssessmentId: string | null = null;
  if (input.includeQualityBridge) {
    const quality = await assessTrendQualityBridge({
      organisationId: input.organisationId,
      subjectKind: "IntelligencePrediction",
      subjectId: "pending",
      sampleSize:
        typeof input.features.sampleSize === "number" ? input.features.sampleSize : null,
      sourceCount:
        typeof input.features.crossPlatformCount === "number"
          ? input.features.crossPlatformCount
          : null,
    });
    features = {
      ...features,
      qualityBridge: {
        available: quality.available,
        stub: quality.stub,
        note: quality.note,
        dimensions: quality.dimensions,
      },
    };
    // qualityAssessmentId stays null until Track 5 quality module persists assessments.
    qualityAssessmentId = quality.qualityAssessmentId;
  }

  const row = await prisma.$transaction(async (tx) => {
    const prediction = await tx.intelligencePrediction.create({
      data: {
        organisationId: input.organisationId,
        predictionType: input.predictionType,
        statement: input.statement.slice(0, 8_000),
        horizonAt: input.horizonAt,
        features: features as Prisma.InputJsonValue,
        modelVersion: input.modelVersion ?? PREDICTION_LAB_MODEL_VERSION,
        confidenceBand: band.band,
        expectedOutcome: (input.expectedOutcome ?? {
          direction: "positive",
          note: "Heuristic expected direction — not a virality guarantee",
        }) as Prisma.InputJsonValue,
        evaluationStatus: PredictionEvaluationStatus.PENDING,
        trendClusterId: input.trendClusterId ?? null,
        qualityAssessmentId,
      },
    });
    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "INTELLIGENCE_PREDICTION_RECORDED",
      aggregateType: "IntelligencePrediction",
      aggregateId: prediction.id,
      payload: {
        predictionId: prediction.id,
        predictionType: prediction.predictionType,
      },
      dedupeKey: `INTELLIGENCE_PREDICTION_RECORDED:${prediction.id}`,
    });
    return prediction;
  });

  return {
    prediction: row,
    confidenceBand: band.band,
    confidenceReasons: band.reasons,
    disclaimer: PREDICTION_LAB_DISCLAIMER,
  };
}

/** Alias — attach ground truth and score (see backtest.setActualOutcomeAndScore). */
export async function attachActualOutcome(input: {
  organisationId: string;
  predictionId: string;
  actualOutcome: import("@/services/continuous-intelligence/backtest").ActualOutcomePayload;
  scorerVersion?: string;
}) {
  const { setActualOutcomeAndScore } = await import(
    "@/services/continuous-intelligence/backtest"
  );
  return setActualOutcomeAndScore(input);
}

export async function getPrediction(input: {
  organisationId: string;
  predictionId: string;
}) {
  return prisma.intelligencePrediction.findFirst({
    where: { id: input.predictionId, organisationId: input.organisationId },
    include: { evaluations: { orderBy: { createdAt: "desc" }, take: 5 } },
  });
}

export async function listPredictions(input: {
  organisationId: string;
  predictionType?: string;
  take?: number;
}) {
  return prisma.intelligencePrediction.findMany({
    where: {
      organisationId: input.organisationId,
      ...(input.predictionType ? { predictionType: input.predictionType } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: input.take ?? 50,
  });
}
