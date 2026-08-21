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

- `src/kernel` types: Mission, Task, ToolDefinition, RiskLevel, PolicyDecision  
- Tool registry wrapping existing adapters  
- Policy checks aligned with Autopilot  
- Mission/task persistence **or** thin wrapper over AgentRun (decide in implementation PR)  
- Admin-visible run metadata (tools, cost) from real data only  
- Unit tests for registry + policy  

Exit criteria: existing Ask research path still works; new kernel APIs tested.

---

## Phase 2 — Knowledge & Memory V2

- Wire knowledge retrieval into supervisor context  
- Memory kinds: knowledge, episodic, entity, working, performance, preference  
- Provenance on retrieved chunks  
- Agents must not promote uncertain findings to Knowledge without approval  

---

## Phase 3 — Research & Evidence Fabric

- Research Source Registry + connection states  
- SourceSnapshot, Claim confidence/freshness  
- Parallel independent research tasks via Kernel  
- Stronger critic (excerpt grounding)  
- Integration capability matrix doc + API  

---

## Phase 4 — Social Intelligence

- Canonical SocialContent + MetricSnapshot (time series)  
- Ingestion jobs on worker  
- Relationships (creator/topic/format) in Postgres + pgvector where useful  

---

## Phase 5 — Trend & Algorithm Intelligence

- Trend lifecycle states + feature pipeline  
- AlgorithmChange evidence store (official vs observational)  
- Probabilistic forecasts with uncertainty  
- Backtest harness (display metrics only when real history exists)  

---

## Phase 6 — Content Operating System

- ContentOpportunity → Idea → Brief → Piece → Variant → Approval → Publish → Measure  
- Connect to research evidence (“Why recommend this?”)  
- Publishing only via approved APIs  

---

## Phase 7 — Universal CRM + Revenue

- Account/Company, Opportunity/Deal (coexist with Lead)  
- Customer 360 view  
- Attribution with explicit confidence/limitations  
- Industry workspace templates (config, not forks)  

---

## Phase 8 — Automation OS

- Trigger → conditions → agent/logic → actions → approval → outcome  
- NL → visible workflow  
- Visual builder (after NL path is solid)  

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
