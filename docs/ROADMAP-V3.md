# Roadmap V3 — Production Intelligence OS

**Prerequisite:** V2 architecture slices shipped. V2 “done” ≠ production-verified.  
**Reality baseline:** [`V3-REALITY-AUDIT.md`](./V3-REALITY-AUDIT.md).

Work one vertical slice at a time. After each slice: typecheck, lint, tests, migration review, tenant-isolation tests, docs, implementation report with maturity before→after.

Never use `prisma db push` on populated/production databases — `prisma migrate deploy` only.

---

## Phase 11 — Security & secret hardening

**Status:** Implemented (WORKING controls — not PRODUCTION_VERIFIED). Report: [`PHASE-11-REPORT.md`](./PHASE-11-REPORT.md).

- [x] Secret validation (prod hard-fail defaults)
- [x] CI secret scanning; block accidental `.env` commits
- [x] Credential health + rotation metadata (no silent ENCRYPTION_KEY rewrite)
- [x] Webhook replay window + existing idempotency
- [x] PII-aware logging / redaction
- [x] SSRF-safe fetch for user-controlled URLs
- [x] Untrusted content labelling (strip markers = defence-in-depth only; not claimed as injection prevention)
- [x] Tool/agent capability permission tests
- [x] Operator manual credential rotation doc

## Phase 12 — Durable Mission runtime

**Status:** Implemented + acceptance gate (WORKING — not PRODUCTION_VERIFIED / not LIVE_E2E). Stop before 12B.

- [x] AgentMission / MissionTask / Dependency / Checkpoint / Artifact / Outcome
- [x] Reuse AgentRun / AgentStep / ToolCall (optional missionId links)
- [x] Validated Mission state machine
- [x] Durable resume / idempotency / cancel / budget / approval wait
- [x] Compare-and-swap task claim (duplicate worker delivery)
- [x] External outcome states (NOT_STARTED / DISPATCHING / CONFIRMED / FAILED / RECONCILIATION_REQUIRED)
- [x] Approval identity + timestamp + rejection; resume cannot bypass
- [x] Outbox attach hook (`prepareDomainEventAttach` → real transactional append)
- [x] Legacy BullMQ cleanup utility (dry-run default)
- [ ] Ask UI wiring to Mission (later)
- [x] Mission queue recovery after Redis loss (Phase 12B)
- [x] Phase 12B transactional outbox (**WORKING**)

## Phase 12B — Transactional domain events

**Status:** Implemented (WORKING — local/DB/tests; not LIVE_E2E / not PRODUCTION_VERIFIED).

- [x] DomainEvent + DomainEventConsumption
- [x] Typed catalogue + Zod payloads
- [x] `appendDomainEvent(tx, …)` atomic attach
- [x] Postgres dispatcher (`FOR UPDATE SKIP LOCKED`)
- [x] Fan-out consumers + idempotency
- [x] Automation + Mission integration
- [x] Mission queue recovery after Redis loss
- [x] Admin outbox API + AI Ops snapshot fields
- [ ] Multi-worker production soak / PRODUCTION_VERIFIED

## Phase 13 — Business Intelligence Core (13A / 13B / 13C)

**Status:** Implemented (**WORKING** — local/DB/tests; not LIVE_E2E / not PRODUCTION_VERIFIED).  
Architecture: [`PHASE-13-BUSINESS-INTELLIGENCE.md`](./PHASE-13-BUSINESS-INTELLIGENCE.md).  
Domain event coverage matrix: [`DOMAIN-EVENT-COVERAGE.md`](./DOMAIN-EVENT-COVERAGE.md).

### 13A Goal & KPI
- [x] Goal / KpiDefinition / KpiTarget / KpiSnapshot / Initiative / GoalLink
- [x] Deterministic KPI calculators
- [x] Transactional GOAL_* / KPI_SNAPSHOT_RECORDED events
- [x] Minimal `/goals` UI + `/api/goals`

### 13B Digital Twin
- [x] ProductOffering / AudienceSegment / EntityRelation / BusinessClaim
- [x] Business profile + completeness (honest gaps)
- [x] Freshness policy registry
- [x] Minimal `/business-context` UI

### 13C Opportunity graph
- [x] BusinessOpportunity + Evidence + Outcome + DetectorRun
- [x] Detectors: deal_risk, lead_reactivation, audience_objection, kpi_at_risk
- [x] Priority / confidence / impact / urgency bands (deterministic)
- [x] Opportunity → Mission
- [x] Chief of Staff facts (`?v=2`) + Ask context budget
- [x] Worker Postgres sweeps (detectors ~15m, KPI refresh ~1h)
- [ ] Continuous trend/content/competitor detectors (need data plane)
- [ ] Full Home redesign / onboarding UX (later)

## Phase 14 — Integration mesh + Tool/Skill platform

**Status:** 14A–E **WORKING**; **14F Intelligence Quality WORKING** (deterministic gates — not LIVE_E2E). Phase 14 complete only with 14F.  
Docs: [`PHASE-14-INTEGRATION-MESH.md`](./PHASE-14-INTEGRATION-MESH.md).

### 14A–E
- [x] Connector SDK catalogue + capability states + provenance
- [x] ExternalObjectMapping + SyncCursor/SyncRun
- [x] Rate limit + circuit breaker
- [x] Provider health events (bounded)
- [x] Tool Registry connector tools + authorize path
- [x] Skill registry (versioned builtins)
- [x] Reconciliation contract for consequential ops
- [x] Optional MCP deny-by-default boundary
- [x] `/integrations` mesh UI + `/api/integrations/mesh`
- [x] DEAL_WON/LOST/STAGE_CHANGED outbox emits
- [ ] Full OAuth refresh worker loop (TikTok adapter has refresh; no mesh-wide loop yet)

### 14F — Intelligence Quality & Verification Engine
- [x] Claim normalisation + lineage + corroboration + contradiction + freshness + relevance + social quality
- [x] Quality budgets FAST/STANDARD/DEEP/MISSION_CRITICAL
- [x] Quality gate → BusinessOpportunity.qualityGateStatus (NEEDS_MORE_RESEARCH / CONFLICTED / INSUFFICIENT_EVIDENCE / STALE / REJECTED / PASSED)
- [x] Traceability chain Opportunity → Claim → Evidence → Snapshot → Provider → retrieval time
- [ ] Empirical calibration of confidence bands (Phase 17 samples)

## Phase 15 — Real execution (Content publish)

**Status:** **WORKING** architecture (dispatch + approval + Postgres sweep). Per-provider **not LIVE_E2E** until real OAuth publish proof.

- [x] PublishingJob externalOutcome ledger (PREPARED/DISPATCHING/CONFIRMED/FAILED/RECONCILIATION_REQUIRED)
- [x] `dispatchPublishingJob` → social adapter.publish → recordPublishResult (requires externalPostId)
- [x] Worker Postgres publishing sweep (no new BullMQ worker)
- [x] Job-bound approval description
- [ ] LIVE_E2E LinkedIn/Instagram/TikTok with real credentials

## Phase 15B — Action mesh

Same gates for CRM/email/calendar/messages — still deferred where adapters incomplete.

## Phase 16 — Continuous intelligence

**Status:** **WORKING** time-series/lifecycle rules; Prediction Lab **FOUNDATION** (no accuracy claims).

## Phase 16B — Knowledge & Memory V3

Production embedding path; hybrid retrieval; memory kinds with provenance/TTL.

## Phase 16C — Prediction Lab

**Status:** **FOUNDATION** — record + backtest scaffolding; no invented historical accuracy.

## Phase 17 — Evaluation platform

**Status:** **FOUNDATION/WORKING** — datasets, scorers, shadow/canary states, calibration samples; no auto-promote.
Candidate → Evaluate → Shadow → Canary → Promote → Rollback.

## Phase 17B — Online outcome learning

Preference vs empirical performance; no fake causality.

## Phase 18 — Enterprise operating layer

SSO/SCIM/MFA architecture, audit export, OTel, cost per mission — without infra jargon in customer UI.

## Product UX (ongoing)

Simplify nav toward Home / Ask / CRM / Growth / Automate / Analytics; CoS Home driven by Opportunities.

---

## Definition of done (any V3 feature)

Must pass applicable: real data, model, service, API, UI, worker, provider, live E2E, tenant isolation, permissions, idempotency, failure mode, recovery, observability, cost metering, tests, documentation — or stay at a lower maturity label honestly.
