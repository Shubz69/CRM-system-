/**
 * Organisation-scoped messaging pattern learning (Creative Genome adjacent).
 * Minimum samples required — no content/genome conflation.
 */

export type MessagingPatternOutcome =
  | "QUALIFIED_PROGRESSION"
  | "MEETING"
  | "DEAL_PROGRESSION"
  | "REPLY_ONLY";

export type MessagingPatternKey =
  | "opening"
  | "question_order"
  | "cta"
  | "objection_response"
  | "follow_up_delay"
  | "channel"
  | "stage";

const MIN_SAMPLES = 20;

export function canPromoteMessagingPattern(sampleCount: number): boolean {
  return Number.isFinite(sampleCount) && sampleCount >= MIN_SAMPLES;
}

/**
 * Score pattern quality — reply rate alone is insufficient.
 * Prefer outcomes that evidence commercial progression.
 */
export function scoreMessagingPattern(input: {
  samples: number;
  qualifiedProgression: number;
  meetings: number;
  dealProgression: number;
  repliesOnly: number;
}): { score: number; eligible: boolean; reason: string } {
  if (!canPromoteMessagingPattern(input.samples)) {
    return {
      score: 0,
      eligible: false,
      reason: `Need at least ${MIN_SAMPLES} samples before promotion`,
    };
  }
  const weighted =
    input.qualifiedProgression * 2 +
    input.meetings * 3 +
    input.dealProgression * 4 +
    input.repliesOnly * 0.25;
  const score = weighted / input.samples;
  return {
    score,
    eligible: score >= 0.5,
    reason:
      score >= 0.5
        ? "Pattern meets minimum commercial outcome threshold"
        : "Reply-heavy pattern without enough commercial progression",
  };
}
