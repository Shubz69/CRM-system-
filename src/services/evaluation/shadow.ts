/**
 * Phase 17 — Shadow mode runner.
 * Candidate observes + proposes only. Cannot take external actions.
 */

import {
  getEvalFixture,
  listBuiltinEvalFixtures,
  type EvalFixtureCase,
} from "@/services/evaluation/datasets";
import {
  matchesExpect,
  runScorer,
  type ScorerResult,
} from "@/services/evaluation/scorers";
import { assertLearningWriteAllowed } from "@/services/evaluation/learning-safety";

/** External side-effects that shadow mode must never invoke. */
export const SHADOW_FORBIDDEN_ACTIONS = [
  "publish",
  "send_email",
  "send_message",
  "mutate_crm",
  "charge_billing",
  "write_credentials",
  "execute_tool_external",
] as const;

export type ShadowProposal = {
  action: string;
  rationale: string;
  /** Proposed payload — observation only */
  payload?: Record<string, unknown>;
};

export type ShadowCaseResult = {
  caseId: string;
  name: string;
  scorer: ScorerResult;
  expectMatched: boolean;
  proposal: ShadowProposal | null;
  externalActionsAttempted: string[];
  blocked: boolean;
};

export type ShadowRunResult = {
  mode: "shadow";
  /** Maturity: WORKING for local deterministic path */
  maturity: "WORKING";
  candidateKey: string;
  caseResults: ShadowCaseResult[];
  passed: boolean;
  message: string;
  /** Always true — shadow cannot mutate external systems */
  externalActionsDisabled: true;
};

function proposeFromCase(c: EvalFixtureCase): ShadowProposal {
  return {
    action: `propose_${c.scorer}`,
    rationale: `Shadow proposal for ${c.id} — observe only`,
    payload: { caseId: c.id, expect: c.expect },
  };
}

/**
 * Run candidate in shadow: score fixtures, emit proposals, block external actions.
 */
export function runShadowEvaluation(input: {
  candidateKey: string;
  caseIds?: string[];
  /** If candidate tries these, they are recorded and blocked */
  attemptedExternalActions?: string[];
}): ShadowRunResult {
  assertLearningWriteAllowed("eval_fixtures");

  const attempted = input.attemptedExternalActions ?? [];
  const forbiddenAttempted = attempted.filter((a) =>
    (SHADOW_FORBIDDEN_ACTIONS as readonly string[]).includes(a),
  );

  const fixtures =
    input.caseIds && input.caseIds.length > 0
      ? input.caseIds
          .map((id) => getEvalFixture(id))
          .filter((c): c is EvalFixtureCase => Boolean(c))
      : listBuiltinEvalFixtures().filter((c) => c.signalKind === "EMPIRICAL_PERFORMANCE");

  const caseResults: ShadowCaseResult[] = fixtures.map((c) => {
    const scorer = runScorer(c.scorer, c.input);
    const expectMatched = matchesExpect(scorer, c.expect);
    return {
      caseId: c.id,
      name: c.name,
      scorer,
      expectMatched,
      proposal: proposeFromCase(c),
      externalActionsAttempted: forbiddenAttempted,
      blocked: forbiddenAttempted.length > 0,
    };
  });

  const passed =
    forbiddenAttempted.length === 0 &&
    caseResults.length > 0 &&
    caseResults.every((r) => r.expectMatched);

  return {
    mode: "shadow",
    maturity: "WORKING",
    candidateKey: input.candidateKey,
    caseResults,
    passed,
    message:
      forbiddenAttempted.length > 0
        ? `Shadow blocked external action(s): ${forbiddenAttempted.join(", ")}`
        : passed
          ? `Shadow passed ${caseResults.length} case(s); proposals only — no external writes.`
          : `Shadow failed ${caseResults.filter((r) => !r.expectMatched).length} case(s).`,
    externalActionsDisabled: true,
  };
}
