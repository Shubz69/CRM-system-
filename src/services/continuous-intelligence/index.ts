/**
 * Phase 16 — Continuous Intelligence / Prediction Lab
 *
 * Maturity:
 * - Time-series collection + lifecycle rules: WORKING
 * - Prediction accuracy / calibration: FOUNDATION (transparent bands; no invented hit rates)
 */

export {
  appendMetricHistory,
  recordContinuousCollectionRun,
  runContinuousCollectionPass,
  type CollectionRunInput,
  type MetricObservation,
} from "@/services/continuous-intelligence/collection";

export {
  applyLifecycleFromClusterHistory,
  deriveLifecycleFromFeatures,
  deriveLifecycleFromHistory,
  lifecycleStateToLabel,
  type LifecycleDerivation,
  type LifecycleHistoryPoint,
} from "@/services/continuous-intelligence/trend-lifecycle";

export {
  buildBaselineFromViews,
  normalisePerformance,
  type BaselineStats,
  type NormalisationInput,
  type NormalisationResult,
} from "@/services/continuous-intelligence/normalisation";

export {
  createIntelligencePrediction,
  deriveConfidenceBand,
  getPrediction,
  listPredictions,
  PREDICTION_LAB_DISCLAIMER,
  PREDICTION_LAB_MODEL_VERSION,
  type ConfidenceBand,
  type PredictionFeatures,
} from "@/services/continuous-intelligence/prediction-lab";

export {
  BACKTEST_SCORER_VERSION,
  getPredictionBacktestSummary,
  scorePredictionIfOutcomePresent,
  setActualOutcomeAndScore,
  type ActualOutcomePayload,
  type PredictionBacktestSummary,
} from "@/services/continuous-intelligence/backtest";

export {
  assessTrendQualityBridge,
  type TrendQualityBridgeInput,
  type TrendQualityBridgeResult,
  type TrendQualityDimensions,
} from "@/services/continuous-intelligence/quality-bridge";
