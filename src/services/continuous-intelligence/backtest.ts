/**
 * Prediction Lab backtest — score only when actualOutcome is set.
 * Never fabricate historical accuracy without scored samples.
 */

import { Prisma, PredictionEvaluationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

export const BACKTEST_SCORER_VERSION = "rules-v1";

export type ActualOutcomePayload = {
  /** Realised direction: true = positive / up, false = negative / down. */
  directionPositive?: boolean;
  realizedState?: string;
  metricValue?: number;
  notes?: string;
  [key: string]: unknown;
};

export type ExpectedOutcomePayload = {
  direction?: "positive" | "negative" | string;
  directionPositive?: boolean;
  [key: string]: unknown;
};

function readExpectedPositive(expected: unknown): boolean | null {
  if (!expected || typeof expected !== "object") return null;
  const e = expected as ExpectedOutcomePayload;
  if (typeof e.directionPositive === "boolean") return e.directionPositive;
  if (e.direction === "positive") return true;
  if (e.direction === "negative") return false;
  return null;
}

function readActualPositive(actual: ActualOutcomePayload): boolean | null {
  if (typeof actual.directionPositive === "boolean") return actual.directionPositive;
  if (typeof actual.realizedState === "string") {
    const s = actual.realizedState.toUpperCase();
    if (
      s === "ACCELERATING" ||
      s === "BREAKOUT" ||
      s === "BREAKING_OUT" ||
      s === "MAINSTREAM" ||
      s === "MATURE" ||
      s === "RECURRING"
    ) {
      return true;
    }
    if (s === "DECLINING" || s === "SATURATED" || s === "SATURATING") return false;
  }
  return null;
}

/**
 * Attach ground truth and write a PredictionEvaluation when direction is scorable.
 */
export async function setActualOutcomeAndScore(input: {
  organisationId: string;
  predictionId: string;
  actualOutcome: ActualOutcomePayload;
  scorerVersion?: string;
}) {
  const prediction = await prisma.intelligencePrediction.findFirst({
    where: { id: input.predictionId, organisationId: input.organisationId },
  });
  if (!prediction) {
    throw new Error("Prediction not found for organisation");
  }

  const expectedPositive = readExpectedPositive(prediction.expectedOutcome);
  const actualPositive = readActualPositive(input.actualOutcome);

  let directionCorrect: boolean | null = null;
  let precisionNote: string;
  let evaluationStatus: PredictionEvaluationStatus = PredictionEvaluationStatus.SCORED;

  if (expectedPositive == null || actualPositive == null) {
    directionCorrect = null;
    evaluationStatus = PredictionEvaluationStatus.INVALID;
    precisionNote =
      "Cannot score direction: expectedOutcome and/or actualOutcome lack a comparable direction signal.";
  } else {
    directionCorrect = expectedPositive === actualPositive;
    precisionNote = directionCorrect
      ? "Direction matched expectedOutcome."
      : "Direction diverged from expectedOutcome.";
  }

  const metrics: Record<string, unknown> = {
    expectedPositive,
    actualPositive,
    directionCorrect,
    horizonAt: prediction.horizonAt.toISOString(),
    confidenceBand: prediction.confidenceBand,
    modelVersion: prediction.modelVersion,
    scoredAt: new Date().toISOString(),
  };
  if (typeof input.actualOutcome.metricValue === "number") {
    metrics.metricValue = input.actualOutcome.metricValue;
  }

  const updated = await prisma.intelligencePrediction.update({
    where: { id: prediction.id },
    data: {
      actualOutcome: input.actualOutcome as Prisma.InputJsonValue,
      evaluationStatus,
      scoredAt: new Date(),
    },
  });

  const evaluation = await prisma.predictionEvaluation.create({
    data: {
      organisationId: input.organisationId,
      predictionId: prediction.id,
      directionCorrect,
      precisionNote,
      metrics: metrics as Prisma.InputJsonValue,
      scorerVersion: input.scorerVersion ?? BACKTEST_SCORER_VERSION,
    },
  });

  return { prediction: updated, evaluation, directionCorrect, precisionNote };
}

/**
 * Score an existing prediction that already has actualOutcome set (idempotent-ish append).
 */
export async function scorePredictionIfOutcomePresent(input: {
  organisationId: string;
  predictionId: string;
}) {
  const prediction = await prisma.intelligencePrediction.findFirst({
    where: { id: input.predictionId, organisationId: input.organisationId },
  });
  if (!prediction) throw new Error("Prediction not found for organisation");
  if (prediction.actualOutcome == null) {
    return {
      scored: false as const,
      reason: "actualOutcome not set — refusing to fabricate a score",
    };
  }
  const result = await setActualOutcomeAndScore({
    organisationId: input.organisationId,
    predictionId: input.predictionId,
    actualOutcome: prediction.actualOutcome as ActualOutcomePayload,
  });
  return { scored: true as const, ...result };
}

export type PredictionBacktestSummary = {
  sampleSize: number;
  /** null when sampleSize === 0 — never invent accuracy. */
  directionAccuracy: number | null;
  scoredWithDirection: number;
  message: string;
  maturity: "FOUNDATION";
};

/**
 * Aggregate direction accuracy only over real PredictionEvaluation rows with non-null directionCorrect.
 */
export async function getPredictionBacktestSummary(input: {
  organisationId: string;
}): Promise<PredictionBacktestSummary> {
  const rows = await prisma.predictionEvaluation.findMany({
    where: {
      organisationId: input.organisationId,
      directionCorrect: { not: null },
    },
    take: 500,
  });

  if (!rows.length) {
    return {
      sampleSize: 0,
      directionAccuracy: null,
      scoredWithDirection: 0,
      message:
        "No scored predictions with direction ground truth yet — accuracy metrics are hidden until real samples exist.",
      maturity: "FOUNDATION",
    };
  }

  const correct = rows.filter((r) => r.directionCorrect === true).length;
  return {
    sampleSize: rows.length,
    directionAccuracy: correct / rows.length,
    scoredWithDirection: rows.length,
    message: `Based on ${rows.length} scored prediction${rows.length === 1 ? "" : "s"} with direction ground truth.`,
    maturity: "FOUNDATION",
  };
}
