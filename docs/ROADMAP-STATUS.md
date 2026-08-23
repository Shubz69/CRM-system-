# Roadmap status — Phase 0 → 10

Incremental Agent Desk AI Operating System. Prefer migrations over `db push`. Never fake production data.

Canonical checklist: [`ROADMAP-V2.md`](./ROADMAP-V2.md). Architecture: [`TARGET-ARCHITECTURE-V2.md`](./TARGET-ARCHITECTURE-V2.md). Structure overview: [`STRUCTURE-ROADMAP.md`](./STRUCTURE-ROADMAP.md).

**V3:** [`V3-REALITY-AUDIT.md`](./V3-REALITY-AUDIT.md) · [`ROADMAP-V3.md`](./ROADMAP-V3.md) — do not treat V2 “done” as production-verified.

---

## Done (Phase 0 → 10)

| Phase | What shipped |
|-------|----------------|
| **0** | Audit, target architecture, roadmap, kernel/OS docs |
| **1** | Agent Kernel — tool registry, policy, Ask progress shows real tools |
| **2** | Knowledge in Ask + memory models; no silent Knowledge promotion |
| **3** | Evidence fabric — snapshots, claim freshness, grounded critic, capability matrix |
| **4** | Social intelligence — creators/content/metrics, ingest after research |
| **5** | Trends & algorithms — clusters, forecasts, honest backtests |
| **6** | Content OS pipeline (opportunity → publish gate) with `whyEvidence` |
| **7** | Companies, deals, Customer 360 UI, attribution confidence, templates |
| **8** | Automation OS — NL → workflow, approvals, read-only workflow viewer |
| **9** | Feedback, experiments, eval-gated agent versions, backtest on Learning |
| **10** | CoS Home strip, ⌘K → Ask, entitlements/meters, AI Ops, worker blueprints |

**Also done after Phase 10:** tenant isolation hardening (approvals/publish/learning), real spend breakdown from `AiExecution`.

---

## Still open (honest leftovers)

These are **optional / deeper** — cores are done; these need real executors or product depth, not stubs:

1. **Content workspace UI + live OAuth publish E2E** — APIs/adapters exist; missing a worker that actually publishes and records external IDs (highest product gap if you want “post to Instagram” for real).
2. **Full drag-drop automation builder** — NL + read-only viewer exist; builder is deferred on purpose.
3. **Trend dashboards + recurring re-scrape / pgvector clusters** — engine exists; dedicated UI + scheduled jobs don’t.
4. **Deeper provider health heartbeats** — health page is config/live probes; no persisted heartbeat history.
5. **Mission persistence table** — only if `AgentRun` metadata isn’t enough (probably skip unless you hit a wall).
6. **Goal / KPI / Initiative / DomainEvent** — still deferred in the data model.

---

## Recommended next order

1. **Content publish executor** — worker job: `APPROVED` `PublishingJob` → OAuth adapter `publish()` → `recordPublishResult` with real external ID → simple `/content` UI.
2. **Trend page** that calls `/api/trends` (no fake charts).
3. **Drag-drop builder** only if operators outgrow NL + viewer.

**Ops reminder:** production Ask needs Redis + hosted `npm run worker` (Railway/Render configs are in-repo).
