# Trend Forecasting

**Status:** Phase 5 — models + feature pipeline + forecasts + honest backtest.

## Rules

- No certainty claims. Probabilities + uncertainty + drivers + counter-signals.  
- Features first (velocity, acceleration, cross-platform…); lifecycle inferred from features.  
- States: Emerging → Accelerating → Breakout → Mainstream → Saturated → Declining → Recurring.  
- Windows: 24h / 3d / 7d / 30d (primary refresh uses 7d with 3d split for velocity).  

## API

- `GET /api/trends` — clusters + latest forecast + backtest summary  
- `POST /api/trends` — refresh clusters from recent signals/content  
- `GET|POST /api/algorithm-changes` — evidence store (official requires `sourceUrl`)

## Backtest

Store forecasts vs `TrendForecastOutcome`. Metrics (Brier, accuracy) **only returned when real outcomes exist** — never invent hit rates.
