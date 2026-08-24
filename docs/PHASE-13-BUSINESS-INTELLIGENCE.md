# Phase 13 — Business Intelligence Core

**Maturity: WORKING** (local/DB/tests with real application data). Not LIVE_E2E. Not PRODUCTION_VERIFIED.

## Purpose

Understand + Prioritise:

1. What the organisation wants (**Goals / KPIs**)
2. What is known about the business (**Digital Twin aggregation**)
3. What deserves attention (**BusinessOpportunity**)
4. Why (evidence + score factors)
5. What action to take (Mission / Initiative)
6. Outcome hooks for later learning (OpportunityOutcome)

## 13A — Goal & KPI graph

Models: `Goal`, `KpiDefinition`, `KpiTarget`, `KpiSnapshot`, `Initiative`, `GoalLink`.

- Goal ACHIEVED requires explicit KPI evidence (`evidenceMet`).
- KPI calculators are deterministic (`src/services/goals/calculators.ts`) — never LLM.
- Snapshots append history; they do not overwrite.
- Target units must match KPI definition units.

## 13B — Business Digital Twin

Not a second database. Aggregation over existing entities +:

- `ProductOffering`, `AudienceSegment`, `EntityRelation`, `BusinessClaim`
- Controlled entity/relationship registries (`digital-twin/registry.ts`)
- Freshness bands: FRESH / AGING / STALE / UNKNOWN
- Completeness reports factual gaps (not a vanity score)

Competitor = Company + `COMPETES_WITH` relation (role, not duplicate row).

Sensitive attributes (religion, ethnicity, health, etc.) rejected on audience segments.

## 13C — Opportunity graph

Model: `BusinessOpportunity` (not CRM Deal). Evidence: `OpportunityEvidence`. Outcomes: `OpportunityOutcome`.

### Enabled detector types (real data)

| Detector | Type | Data |
|---|---|---|
| deal_risk | DEAL_RISK | Open deals + CrmActivity inactivity |
| lead_reactivation | REACTIVATION | Qualified/high-score leads stale |
| audience_objection | AUDIENCE_NEED | Repeated Objection categories |
| kpi_at_risk | OPERATIONAL | Goal KPI targets behind snapshot |

Trend/content/competitor detectors are **not** live until continuous data exists.

### Scoring (documented, deterministic)

- **Confidence** band from signal count + freshness + source quality → LOW/MEDIUM/HIGH
- **Impact** from deal value / KPI gap / goal priority → LOW…VERY_HIGH
- **Urgency** from inactivity / deadline → LOW…CRITICAL
- **Priority** = impact × urgency × confidence × goalAlignment ÷ effortFactor

LLM may explain scores; it must not invent them.

### Dedupe

`dedupeKey` unique per org (e.g. `deal_risk:v1:{dealId}`). Open opportunities update in place; closed ones suppress recreates.

### Opportunity → Mission

`acceptOpportunityAsMission` → accept (if needed) → `createMission` → link `businessOpportunityId` → IN_PROGRESS.

## Chief of Staff

`buildChiefOfStaffFacts` selects deterministic sections:

WHAT_CHANGED, WHAT_MATTERS, WHAT_IS_AT_RISK, OPPORTUNITIES, RECOMMENDED_ACTIONS, WAITING_FOR_YOU.

Narrative field reserved for later LLM summary of selected facts only.

Ask context: `assembleAskBusinessContext` injects a small budgeted block into agent runs.

## Worker

Postgres intervals (no new BullMQ worker):

- Opportunity detectors default **15 minutes** (`OPPORTUNITY_DETECTOR_INTERVAL_MS`)
- KPI calculator refresh default **60 minutes** (`KPI_REFRESH_INTERVAL_MS`)

## APIs / UI

- `/api/goals`, `/goals`
- `/api/opportunities`, `/opportunities`
- `/api/business-context`, `/business-context`
- `/api/chief-of-staff?v=2`

## Events

Transactional outbox catalogue extended with GOAL_*, KPI_SNAPSHOT_RECORDED, INITIATIVE_STARTED, OPPORTUNITY_*.

See also `docs/DOMAIN-EVENT-COVERAGE.md`.
