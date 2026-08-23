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
- [x] Untrusted content prompt-injection boundaries
- [x] Tool/agent capability permission tests
- [x] Operator manual credential rotation doc

## Phase 12 — Durable Mission runtime

`AgentMission` + tasks/dependencies/checkpoints/outcomes; `AgentRun` remains execution trace; resume across worker restart/outage.

## Phase 12B — Transactional domain events

PostgreSQL outbox; atomic mutation+event; idempotent consumers. No Kafka.

## Phase 13 — Business Goal graph

`Goal` / `Kpi` / targets / snapshots / `Initiative` / `Outcome`; link to campaigns, content, deals, experiments, missions.

## Phase 13B — Business digital twin

Evidence-backed entity relations over existing relational data (no separate graph DB).

## Phase 13C — Opportunity graph

First-class cross-domain `Opportunity` with evidence, goal link, honest confidence.

## Phase 14 — Integration mesh

Granular capability states; OAuth lifecycle; SyncCursor/SyncRun; ProviderHealth; never claim ungained scopes.

## Phase 14B — Tool & Skill platform

Skill registry + versions/evals; optional MCP boundary (untrusted, permission-scoped).

## Phase 15 — Real execution (Content publish)

`/content` workspace + worker publish → real OAuth → external ID → PostPerformance. No fake success.

## Phase 15B — Action mesh

Same gates for CRM/email/calendar/messages.

## Phase 16 — Continuous intelligence

Scheduled ingestion queues with fairness, rate limits, DLQ, idempotency, cost.

## Phase 16B — Knowledge & Memory V3

Production embedding path; hybrid retrieval; memory kinds with provenance/TTL.

## Phase 16C — Prediction Lab

Feature-derived forecasts + calibration metrics (no invented accuracy).

## Phase 17 — Evaluation platform

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
