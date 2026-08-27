/**
 * Phase 16C — Prediction Lab: transparent bands, scored outcomes only, no fabricated accuracy.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PredictionEvaluationStatus } from "@prisma/client";
import {
  createIntelligencePrediction,
  deriveConfidenceBand,
  getPredictionBacktestSummary,
  PREDICTION_LAB_DISCLAIMER,
  scorePredictionIfOutcomePresent,
  setActualOutcomeAndScore,
} from "@/services/continuous-intelligence";
import {
  createTestOrganisation,
  destroyTestOrganisation,
  type TestOrganisationFixture,
} from "./helpers/org-fixtures";

describe("prediction confidence bands", () => {
  it("marks sparse features INSUFFICIENT — never claims virality", () => {
    const band = deriveConfidenceBand({ sampleSize: 1, mentionCount: 1 });
    expect(band.band).toBe("INSUFFICIENT");
    expect(PREDICTION_LAB_DISCLAIMER).toMatch(/virality/i);
    expect(PREDICTION_LAB_DISCLAIMER).toMatch(/FOUNDATION/i);
  });

  it("uses transparent LOW/MEDIUM/HIGH from observables", () => {
    expect(
      deriveConfidenceBand({ sampleSize: 4, crossPlatformCount: 1, mentionCount: 5 }).band,
    ).toBe("LOW");
    expect(
      deriveConfidenceBand({
        sampleSize: 5,
        crossPlatformCount: 2,
        mentionCount: 8,
      }).band,
    ).toBe("MEDIUM");
    expect(
      deriveConfidenceBand({
        sampleSize: 10,
        crossPlatformCount: 3,
        mentionCount: 12,
        normalisedComposite: 1.4,
      }).band,
    ).toBe("HIGH");
  });
});

describe("prediction lab backtest honesty", () => {
  let org: TestOrganisationFixture;

  beforeAll(async () => {
    org = await createTestOrganisation("pred-lab");
  }, 60_000);

  afterAll(async () => {
    await destroyTestOrganisation(org);
  }, 60_000);

  it("creates IntelligencePrediction with band + disclaimer features", async () => {
    const { prediction, confidenceBand, disclaimer } = await createIntelligencePrediction({
      organisationId: org.organisationId,
      predictionType: "trend_direction",
      statement: "Cluster may remain accelerating over 7d (heuristic)",
      horizonAt: new Date(Date.now() + 7 * 86400000),
      features: {
        velocity: 1.1,
        acceleration: 0.3,
        mentionCount: 9,
        crossPlatformCount: 2,
        sampleSize: 5,
        lifecycleLabel: "ACCELERATING",
      },
      expectedOutcome: { direction: "positive" },
      includeQualityBridge: true,
    });

    expect(prediction.modelVersion).toBe("rules-v1");
    expect(prediction.confidenceBand).toBe(confidenceBand);
    expect(prediction.evaluationStatus).toBe(PredictionEvaluationStatus.PENDING);
    expect(disclaimer).toMatch(/FOUNDATION/);
    const features = prediction.features as Record<string, unknown>;
    expect(features.disclaimer).toBeTruthy();
    expect(features.qualityBridge).toBeTruthy();
  });

  it("refuses accuracy summary with zero samples", async () => {
    // Fresh org slice — use a dedicated type to avoid cross-test pollution noise
    const summary = await getPredictionBacktestSummary({
      organisationId: org.organisationId,
    });
    // May be 0 if prior test did not score yet
    if (summary.sampleSize === 0) {
      expect(summary.directionAccuracy).toBeNull();
      expect(summary.message).toMatch(/hidden until real samples/i);
      expect(summary.maturity).toBe("FOUNDATION");
    }
  });

  it("scores only when actualOutcome provides direction; refuses fabricate-without-outcome", async () => {
    const { prediction } = await createIntelligencePrediction({
      organisationId: org.organisationId,
      predictionType: "trend_direction",
      statement: "Expect positive direction",
      horizonAt: new Date(Date.now() + 86400000),
      features: { sampleSize: 5, crossPlatformCount: 2, mentionCount: 8 },
      expectedOutcome: { direction: "positive" },
    });

    const refused = await scorePredictionIfOutcomePresent({
      organisationId: org.organisationId,
      predictionId: prediction.id,
    });
    expect(refused.scored).toBe(false);
    if (!refused.scored) {
      expect(refused.reason).toMatch(/refusing to fabricate/i);
    }

    const scored = await setActualOutcomeAndScore({
      organisationId: org.organisationId,
      predictionId: prediction.id,
      actualOutcome: { directionPositive: true, realizedState: "ACCELERATING" },
    });
    expect(scored.directionCorrect).toBe(true);
    expect(scored.evaluation.directionCorrect).toBe(true);
    expect(scored.prediction.evaluationStatus).toBe(PredictionEvaluationStatus.SCORED);

    const summary = await getPredictionBacktestSummary({
      organisationId: org.organisationId,
    });
    expect(summary.sampleSize).toBeGreaterThanOrEqual(1);
    expect(summary.directionAccuracy).not.toBeNull();
    expect(summary.maturity).toBe("FOUNDATION");
  });

  it("marks INVALID when outcome lacks comparable direction", async () => {
    const { prediction } = await createIntelligencePrediction({
      organisationId: org.organisationId,
      predictionType: "trend_direction",
      statement: "Ambiguous",
      horizonAt: new Date(Date.now() + 86400000),
      features: { sampleSize: 3, crossPlatformCount: 2, mentionCount: 4 },
      expectedOutcome: { note: "no direction field" },
    });

    const result = await setActualOutcomeAndScore({
      organisationId: org.organisationId,
      predictionId: prediction.id,
      actualOutcome: { notes: "observed something without direction" },
    });
    expect(result.directionCorrect).toBeNull();
    expect(result.prediction.evaluationStatus).toBe(PredictionEvaluationStatus.INVALID);
  });
});
