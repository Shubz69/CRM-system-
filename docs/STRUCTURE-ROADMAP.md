# Structure roadmap — Agent Desk AI Operating System

How layers, phases, runtime, and navigation fit together. Pair with [`ROADMAP-V2.md`](./ROADMAP-V2.md), [`ROADMAP-STATUS.md`](./ROADMAP-STATUS.md), [`TARGET-ARCHITECTURE-V2.md`](./TARGET-ARCHITECTURE-V2.md), and [`AI-OPERATING-SYSTEM.md`](./AI-OPERATING-SYSTEM.md).

---

## Layered architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  PRODUCT SURFACES (what users see)                              │
│  Home/Ask · Inbox · Pipeline · Contacts · Companies · Deals     │
│  Knowledge · Insights · Learning · Reports · Agent              │
│  Automations · Integrations · Go Live · Admin AI Ops            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  AGENT KERNEL  (src/kernel + AgentRun / Step / ToolCall)        │
│  Plan · Tools · Policy · Budget · Approvals · Memory hooks      │
└──┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬─────────────┘
   │      │      │      │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼      ▼      ▼      ▼
Know-  Research Social Content  CRM   Auto-  Learn  Enter-
ledge  Fabric   Intel  OS       V2    mation  /Eval  prise
Mem.                                      OS
   │      │      │      │      │      │      │      │
   └──────┴──────┴──────┴──┬───┴──────┴──────┴──────┘
                           ▼
              Adapters (AI, messaging, sources, social OAuth)
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
         Postgres (Supabase)      Redis + Worker
         system of record         long jobs (Ask, publish…)
```

**Closed loop:** Observe → Understand → Decide → Act → Measure → Learn

---

## How phases map onto structure

| Layer | Phases | Role |
|-------|--------|------|
| **Kernel** | 1 | Shared tools, policy, Ask coordination |
| **Knowledge / Memory** | 2 | Org brain in context; no silent publish to Knowledge |
| **Research Fabric** | 3 | Outside world → evidence, snapshots, critic |
| **Social Intel** | 4 | Creators, posts, metrics over time |
| **Trends / Algorithms** | 5 | Lifecycle, forecasts, honest backtests |
| **Content OS** | 6 | Opportunity → piece → approval-gated publish |
| **CRM / Revenue** | 7 | Company, Deal, 360, attribution |
| **Automation OS** | 8 | Trigger → workflow → approval → outcome |
| **Learning** | 9 | Feedback, experiments, eval gates |
| **Enterprise shell** | 10 | CoS Home, ⌘K, entitlements, AI Ops, worker topology |

Phases stack **upward into the UI** and **downward into adapters + worker** — not separate apps.

---

## Runtime topology

| Process | Owns |
|---------|------|
| **Vercel (Next.js)** | UI, APIs, enqueue only |
| **Worker** (`npm run worker`) | Ask / agent-runs, follow-ups, maintenance (publish executor still thin) |
| **Supabase Postgres** | All durable domain data |
| **Upstash Redis** | BullMQ queues |

Long research / agent work never finishes inside a serverless request.

Copy-paste worker hosts: `railway.toml`, `render.yaml`. Details: [`WORKER.md`](./WORKER.md).

---

## Domain data structure (by layer)

| Domain | Core models |
|--------|-------------|
| Kernel | `AgentRun`, `AgentStep`, `ToolCall` |
| Knowledge | `KnowledgeDocument` / chunks, recommendations (+ memory tables) |
| Research | `ResearchJob`, sources, findings, snapshots |
| Social | `SocialCreator`, `SocialContent`, `SocialMetricSnapshot` |
| Trends | `TrendCluster`, forecasts, outcomes, `AlgorithmChange` |
| Content | Opportunity → Idea → Brief → Piece → PublishingJob → PostPerformance |
| CRM | `Company`, `Deal`, `CrmActivity`, Contact/Lead + 360 |
| Automation | `AutomationRule` (+ workflow), `AutomationExecution`, `ApprovalRequest` |
| Learning | `RecommendationFeedback`, `Experiment`, `AgentVersionCandidate`, `EvalSuite` / `EvalRun` |
| Enterprise | `Entitlement`, `UsageMeter`, spend via `AiExecution` |

Schema notes: [`DATA-MODEL-V2.md`](./DATA-MODEL-V2.md).

---

## Nav structure (current product IA)

```text
Primary   Home · Inbox · Pipeline · Contacts · Companies · Deals
Work      Knowledge · Insights · Learning · Reports · AI Agent
Setup     Integrations · Settings · Go Live · Setup Assistant
Secondary Overview · Attention · Autopilot · Automations · …
Admin     Overview · AI Ops · Usage · Health · Failed Jobs · …
```

Source of truth for hrefs: `src/lib/navigation.ts`.

---

## Structural gaps (remaining)

```text
Content OS ──► missing: workspace UI + worker publish executor
Trends     ──► missing: dedicated dashboard + recurring scrape jobs
Automation ──► missing: full drag-drop builder (viewer exists)
Kernel     ──► optional: Mission table (only if AgentRun isn’t enough)
Analytics  ──► deferred: Goal / KPI / Initiative graph
```

Do not invent success rates, confidence meters, or publish IDs without real adapters / ledger rows.
