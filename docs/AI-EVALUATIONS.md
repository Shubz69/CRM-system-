# AI Evaluations

**Status:** Phase 9 — deterministic regression suite + AgentVersionCandidate gates.

Suites: outbound approval gates, publish policy, forecast backtest honesty, NL automation compile, (planned) lead classification, research citation validity, knowledge grounding, brand tone.

Gate AgentVersion / prompt / model changes on suite pass via `promoteAgentVersionCandidate` (status must be `PASSED`). Integrate regression evals into CI where practical (`tests/learning-os.test.ts`, `tests/kernel.test.ts`, `tests/automation-os.test.ts`).

Never delete failing tests to go green.
