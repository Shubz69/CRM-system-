/**
 * Phase 17 — Evaluation / Learning types.
 *
 * Signal kinds must stay separate:
 * - USER_PREFERENCE: thumbs / ratings / explicit preference (not causal proof)
 * - EMPIRICAL_PERFORMANCE: measured outcomes with sample size (still not full causality)
 */

/** Preference feedback — never treat as empirical performance. */
export const SIGNAL_USER_PREFERENCE = "USER_PREFERENCE" as const;
/** Measured outcome metrics — never invent; null when sampleSize is 0. */
export const SIGNAL_EMPIRICAL_PERFORMANCE = "EMPIRICAL_PERFORMANCE" as const;

export type LearningSignalKind =
  | typeof SIGNAL_USER_PREFERENCE
  | typeof SIGNAL_EMPIRICAL_PERFORMANCE;

/**
 * Canary / version rollout states persisted on VersionPerformanceSnapshot.rolloutState.
 * SHADOW = observe-only (no production write). Promotion is explicit — never auto-promote.
 */
export const ROLLOUT_STATES = [
  "CURRENT",
  "CANDIDATE",
  "SHADOW",
  "CANARY",
  "PROMOTED",
  "ROLLED_BACK",
] as const;

export type RolloutState = (typeof ROLLOUT_STATES)[number];

export function isRolloutState(value: string): value is RolloutState {
  return (ROLLOUT_STATES as readonly string[]).includes(value);
}

/** Maturity for evaluation platform surfaces. */
export const EVALUATION_MATURITY = "WORKING" as const;

/** Allowed learning write targets — never production source trees. */
export type LearningWriteTarget =
  | "prompt_weights"
  | "ranking_weights"
  | "versioned_config"
  | "eval_fixtures";
