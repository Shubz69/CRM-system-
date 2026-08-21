# Trend Forecasting

**Status:** Spec (Phase 5).

## Rules

- No certainty claims. Probabilities + uncertainty + drivers + counter-signals.  
- Features first (velocity, acceleration, cross-platform, search demand…); LLM interprets.  
- States: Emerging → Accelerating → Breakout → Mainstream → Saturated → Declining → Recurring.  
- Windows: 24h / 3d / 7d / 30d.  

## Backtest

Store forecasts vs outcomes. Metrics (Brier, precision@K, calibration) **only displayed when real history exists** — never invent hit rates.
