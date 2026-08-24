/**
 * Phase 17 — Evaluation platform (Candidate → Evaluate → Shadow → Canary → Promote → Rollback).
 *
 * USER_PREFERENCE vs EMPIRICAL_PERFORMANCE stay separate in APIs and reports.
 * Maturity: WORKING for deterministic local path; not LIVE_E2E / not PRODUCTION_VERIFIED.
 */

export {
  SIGNAL_USER_PREFERENCE,
  SIGNAL_EMPIRICAL_PERFORMANCE,
  ROLLOUT_STATES,
  EVALUATION_MATURITY,
  isRolloutState,
  type LearningSignalKind,
  type RolloutState,
  type LearningWriteTarget,
} from "@/services/evaluation/types";

export {
  BUILTIN_EVAL_FIXTURES,
  assertNoSecretsInFixture,
  listBuiltinEvalFixtures,
  getEvalFixture,
  type EvalFixtureCase,
} from "@/services/evaluation/datasets";

export {
  scoreSchemaValidity,
  scoreTenantCorrectness,
  scoreCitationCoverage,
  runScorer,
  matchesExpect,
  type ScorerResult,
} from "@/services/evaluation/scorers";

export {
  SHADOW_FORBIDDEN_ACTIONS,
  runShadowEvaluation,
  type ShadowProposal,
  type ShadowCaseResult,
  type ShadowRunResult,
} from "@/services/evaluation/shadow";

export {
  assertRolloutTransition,
  recordVersionPerformanceSnapshot,
  getLatestVersionSnapshot,
  transitionRolloutState,
  shouldAutoPromoteFromSingleRun,
  type VersionArtifactRef,
} from "@/services/evaluation/canary";

export {
  recordConfidenceCalibrationSample,
  getCalibrationHitRateByBand,
  type CalibrationBandReport,
  type CalibrationReport,
} from "@/services/evaluation/calibration";

export {
  LearningSafetyError,
  FORBIDDEN_LEARNING_PATHS,
  assertLearningWriteAllowed,
  assertNotProductionCodePath,
  getLearningSafetyPolicy,
  isAllowedLearningWriteTarget,
  type LearningBoundarySummary,
} from "@/services/evaluation/learning-safety";

import { listBuiltinEvalFixtures } from "@/services/evaluation/datasets";
import { matchesExpect, runScorer } from "@/services/evaluation/scorers";
import { runShadowEvaluation } from "@/services/evaluation/shadow";
import { getLearningSafetyPolicy } from "@/services/evaluation/learning-safety";
import {
  SIGNAL_EMPIRICAL_PERFORMANCE,
  SIGNAL_USER_PREFERENCE,
} from "@/services/evaluation/types";

/**
 * Run deterministic fixture suite (evaluate step before shadow/canary).
 */
export function runDeterministicEvalSuite(options?: { caseIds?: string[] }) {
  const fixtures = listBuiltinEvalFixtures().filter((c) =>
    options?.caseIds ? options.caseIds.includes(c.id) : true,
  );
  const cases = fixtures.map((c) => {
    const scorer = runScorer(c.scorer, c.input);
    const expectMatched = matchesExpect(scorer, c.expect);
    return {
      id: c.id,
      name: c.name,
      signalKind: c.signalKind,
      scorer,
      passed: expectMatched,
    };
  });
  const passed = cases.every((c) => c.passed);
  return {
    maturity: "WORKING" as const,
    signalKindsDocumented: [
      SIGNAL_USER_PREFERENCE,
      SIGNAL_EMPIRICAL_PERFORMANCE,
    ] as const,
    caseCount: cases.length,
    passed,
    cases,
    learningSafety: getLearningSafetyPolicy(),
    message: passed
      ? `All ${cases.length} deterministic cases passed.`
      : `${cases.filter((c) => !c.passed).length} case(s) failed.`,
  };
}

/** Convenience: evaluate then shadow (still no external actions). */
export function evaluateThenShadow(candidateKey: string) {
  const evalResult = runDeterministicEvalSuite();
  const shadow = runShadowEvaluation({ candidateKey });
  return {
    evaluate: evalResult,
    shadow,
    /** Explicit: never auto-promote */
    autoPromote: false as const,
  };
}
