# Learning & Experimentation OS

**Status:** Phase 9 — feedback loop, Experiment, AgentVersionCandidate + eval gates, forecast backtest dashboard.

## Principles

- Feedback is **explicit** (never inferred from silence).
- Experiment winners and metric maps stay **null** when `sampleSize === 0`.
- Forecast backtest Brier/accuracy stay **null** until real `TrendForecastOutcome` rows exist.
- Agent version **promotion requires PASSED** eval suite — never skip failing cases.

## Surfaces

| Path | Role |
|------|------|
| `GET /api/learning` | Dashboard: feedback, experiments, candidates, evals, backtest |
| `POST /api/learning/feedback` | Record recommendation signal |
| `/api/learning/experiments` | Create / start / complete experiments |
| `/api/learning/agent-versions` | Candidates → evaluate → promote |
| `/api/learning/evals` | Run regression suite |
| `/learning` | Operator UI |

Knowledge approve/dismiss writes `RecommendationFeedback` (`accepted` / `dismissed`).

## Default suite

`agent_regression_v1`: outbound approval gate, `social.publish` require_approval, honest empty backtest contract, NL trigger mapping.
