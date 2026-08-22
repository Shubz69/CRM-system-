# Roadmap V2 — Agent Desk AI Operating System

Incremental vertical slices. Keep `main` buildable. Prefer migrations over `db push`. Never fake production data.

---

## Phase 0 — Audit ✅

- [x] Repository audit (`PLATFORM-AUDIT-V2.md`)  
- [x] Target architecture (`TARGET-ARCHITECTURE-V2.md`)  
- [x] This roadmap  
- [x] Kernel / OS / catalogue / data-model docs  

---

## Phase 1 — AI Kernel (foundation)

**Goal:** Shared runtime under all agents without breaking Ask.

Deliverables:

- [x] `src/kernel` types: Mission, Task, ToolDefinition, RiskLevel, PolicyDecision
- [x] Tool registry wrapping existing adapters
- [x] Policy checks aligned with Autopilot
- [x] Unit tests for registry + policy
- [x] Admin Ask progress includes real `kernel.toolsInvoked` + registry summary
- [ ] Mission persistence table (only if AgentRun metadata proves insufficient)

Exit criteria: existing Ask research path still works; new kernel APIs tested.

---

## Phase 2 — Knowledge & Memory V2

- [x] Wire knowledge retrieval into supervisor context (working memory for runs)
- [x] Provenance via `knowledge.retrieve` ToolCall (titles + mode)
- [x] Research query expand + analyst prompts use knowledge without inventing citations
- [x] Episodic / entity / performance / preference memory models
- [x] Agents must not promote uncertain findings to Knowledge without approval (Ask saves forced INACTIVE; ACTIVE blocked for from-ask)

---

## Phase 3 — Research & Evidence Fabric

- [x] Research Source Registry + connection states (`capability-matrix` API)
- [x] SourceSnapshot, Claim confidence/freshness/`claimKind`
- [x] Parallel independent research tasks via Kernel (`searchConfiguredSources` / `mapPool`)
- [x] Stronger critic (excerpt grounding + `flaggedUngrounded`)
- [x] Integration capability matrix doc + API
- [ ] Optional: deeper provider health heartbeats / last-success telemetry UI  

---

## Phase 4 — Social Intelligence

- [x] Canonical SocialContent + MetricSnapshot (time series)
- [x] Ingestion from research / social-listening (worker path via agent execute)
- [x] Relationships (creator / format / topics) in Postgres
- [ ] Dedicated recurring re-scrape jobs + pgvector topic clusters 

---

## Phase 5 — Trend & Algorithm Intelligence

- [x] Trend lifecycle states + feature pipeline (`TrendCluster` / `TrendFeatureSnapshot`)
- [x] AlgorithmChange evidence store (official vs observational)
- [x] Probabilistic forecasts with uncertainty (`TrendForecast`)
- [x] Backtest harness (metrics only when `TrendForecastOutcome` history exists)
- [ ] Richer multi-window feature jobs + UI dashboards 

---

## Phase 6 — Content Operating System

- [x] ContentOpportunity → Idea → Brief → Piece → Variant → Approval → Publish → Measure
- [x] Connect to research evidence (“Why recommend this?” via `whyEvidence`)
- [x] Publishing only via approved APIs (Kernel policy; no fake publish success)
- [ ] Content workspace UI + live OAuth publish adapters end-to-end 

---

## Phase 7 — Universal CRM + Revenue

- [x] Account/Company, Opportunity/Deal (coexist with Lead)
- [x] Customer 360 view (`/api/contacts/[id]/360`)
- [x] Attribution with explicit confidence/limitations
- [x] Industry workspace templates (config, not forks)
- [ ] Richer CRM UI surfaces for deals/companies/360 

---

## Phase 8 — Automation OS

- [x] Trigger → conditions → agent/logic → actions → approval → outcome
- [x] NL → visible workflow (compile before enable)
- [ ] Visual builder (after NL path is solid) 

---

## Phase 9 — Learning & Experimentation

- Recommendation feedback loop  
- Experiment entity  
- Agent version candidates + eval gates before promotion  
- Forecast backtesting dashboards  

---

## Phase 10 — Enterprise product experience

- AI Chief of Staff Home  
- Universal command bar  
- Outcome-based navigation  
- Entitlements + metering  
- Onboarding Agent configuring the workspace  
- Hosted worker as default production topology  
- AI Ops observability console  

---

## Parallel continuous work

- Isolation + permission tests for every new domain  
- Cost intelligence improvements  
- Security reviews on tool fetch / publish / messaging  
- Documentation updates per phase  

---

## Explicit non-goals (near term)

- Rewriting Next.js version or abandoning Prisma  
- Adding Kafka / separate graph DB without proven need  
- Scraping behind ToS for demos  
- Fake confidence meters  
