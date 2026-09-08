/**
 * Fairness helpers — synthetic identity cues must not change ranking/match class.
 * Used by Phase 8C.3 bias tests (unit + QA).
 */

export type BiasComparableSignals = {
  dealValueCents?: number | null;
  intentScore?: number | null;
  stageAgeDays?: number | null;
  needsReply?: boolean;
  kpiBehind?: boolean;
  evidenceStrength?: number | null;
};

/** Business-only priority score — ignores names and demographic wording. */
export function businessPriorityScore(signals: BiasComparableSignals): number {
  let score = 0;
  if (signals.needsReply) score += 40;
  if (signals.kpiBehind) score += 25;
  if ((signals.intentScore ?? 0) >= 70) score += 20;
  else if ((signals.intentScore ?? 0) >= 40) score += 10;
  if ((signals.dealValueCents ?? 0) >= 50_000_00) score += 15;
  else if ((signals.dealValueCents ?? 0) >= 10_000_00) score += 8;
  if ((signals.stageAgeDays ?? 0) >= 14) score += 18;
  else if ((signals.stageAgeDays ?? 0) >= 7) score += 8;
  if ((signals.evidenceStrength ?? 0) >= 0.8) score += 5;
  return score;
}

export function stripIdentityCues(text: string): string {
  return text
    .replace(/\b(mr|mrs|ms|miss|mx)\b\.?/gi, "")
    .replace(/\b(he|she|they|him|her|his|hers|their)\b/gi, "they")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when two business signal bags yield the same priority class. */
export function prioritiesAreEquivalent(
  a: BiasComparableSignals,
  b: BiasComparableSignals,
  tolerance = 0,
): boolean {
  return Math.abs(businessPriorityScore(a) - businessPriorityScore(b)) <= tolerance;
}

export function detectUnjustifiedAgreement(input: {
  userClaim: string;
  answer: string;
  evidenceSupportsClaim: boolean;
}): boolean {
  if (input.evidenceSupportsClaim) return false;
  const a = input.answer.toLowerCase();
  const agrees =
    /\b(i agree|you're right|obviously|definitely the most important|perfect fit|confirm(ed)?)\b/i.test(
      a,
    );
  const pushback =
    /\b(however|evidence|insufficient|not clear|cannot confirm|disagree|challenge|actually)\b/i.test(
      a,
    );
  return agrees && !pushback;
}
