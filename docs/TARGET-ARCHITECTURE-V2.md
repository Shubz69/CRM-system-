# Target Architecture V2 — AI Business Operating System

Maps the product vision onto **this repository**. Prefer extending existing layers over greenfield rewrites.

---

## 1. Architectural principle

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Frontend (simple outcomes)                                               │
│ Home · Ask · Opportunities · CRM · Content · Intelligence · Agents · …   │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────────┐
│ Agent Kernel                                                             │
│ Missions · Plans · Tasks · Tools · Policy · Memory · Budget · Approvals  │
└───┬───────────┬───────────┬───────────┬───────────┬───────────┬──────────┘
    │           │           │           │           │           │
    ▼           ▼           ▼           ▼           ▼           ▼
 Knowledge   Research    Social      Content     CRM        Automation
 Memory      Fabric      Intel       OS          Record     Engine
    │           │           │           │           │           │
    └───────────┴───────────┴─────┬─────┴───────────┴───────────┘
                                  ▼
                         Tool / Integration Layer
                         (adapters + capability matrix)
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
              Postgres (Supabase)          Redis + Worker
              system of record             durable execution
```

**CRM** = system of record  
**Knowledge** = organisational brain  
**Research Fabric** = outside world  
**Social Intelligence** = changing behaviour  
**Forecasting** = probabilistic next  
**Agent Kernel** = decide & coordinate  
**Automation** = deterministic workflows  
**Tools** = external actions  
**Content OS** = distribution  
**Revenue Intelligence** = commercial impact  
**Evaluations** = whether AI is improving  

---

## 2. Map onto existing repo

| Target component | Existing foundation | Evolution |
|------------------|---------------------|-----------|
| Agent Kernel | `src/agents/*`, `AgentRun`/`Step`/`ToolCall`, `agent-runs.ts` | Add `src/kernel/` + Mission/Task tables; wrap agents |
| Tool Layer | `src/adapters/**`, `ToolCall` | Formal ToolRegistry + risk/permission metadata |
| Model routing | `ai-models.ts`, `ai-router.ts`, adapters | Capability registry + fallbacks |
| Knowledge Memory | `knowledge.ts`, chunks + embeddings | Memory kinds + agent context builder |
| Research Fabric | sources adapters, ResearchJob/* | Source Registry, snapshots, claim confidence |
| Social Intel | SocialPost, TrendSignal, Apify, SocialConnection | Metric snapshots, graph relations |
| Content OS | Asset, Campaign, Ask content outcome | ContentPiece lifecycle |
| CRM Record | Contact, Lead, Pipeline, … | Account, Opportunity, Activities |
| Automation | AutomationRule, Autopilot | NL→workflow + agent actions |
| Approvals | AutopilotConfig, AWAITING_*, KnowledgeRecommendation | Unified ApprovalRequest |
| Cost | AiExecution, OrganisationAiBudget | Mission/tool/provider rollups |
| Observability | admin health, failed jobs, Ask details | AI Ops mission graph UI |
| Entitlements | `Organisation.plan`, limits | EntitlementService |
| Execution | Vercel + BullMQ worker | More queues; never long work in request |

---

## 3. Runtime topology (unchanged principle)

| Process | Role |
|---------|------|
| Vercel Next.js | UI, APIs, enqueue, sync inbound AI only |
| Worker | agent-runs, research, ingestion, forecasts, publish, maintenance |
| Supabase | Postgres + pgvector |
| Upstash | Redis / BullMQ |

Long multi-source research **never** completes inside a Vercel serverless request.

---

## 4. Execution graph (target)

```text
Mission
  → Plan
    → AgentTask(s) [parallel where independent]
      → AgentStep(s)
        → ToolCall(s)
          → Evidence / SourceSnapshot
      → Artifact
    → Decision / Approval
  → Action (CRM / publish / message)
  → Outcome
  → Evaluation
```

Persist by **extending** `AgentRun` / `AgentStep` / `ToolCall` rather than discarding them. Introduce `Mission` as parent when multi-run work is needed.

---

## 5. Frontend information architecture (target)

| Nav | Purpose |
|-----|---------|
| **Home** | Chief of Staff: what changed, risks, opportunities, next actions |
| **Ask** | Universal NL control (also command bar) |
| **Opportunities** | Unified opportunity graph |
| **CRM** | Contacts, companies, opportunities, conversations, pipeline |
| **Content** | Ideas → briefs → assets → calendar → publish → measure |
| **Automations** | Workflows + NL builder |
| **Agents** | Catalogue + custom agents |
| **Intelligence** | Trends, competitors, listening, algorithm evidence |
| **Analytics** | Social + CRM + revenue (with confidence) |
| **Knowledge** | Approved company truth |
| **Integrations** | Capability matrix |
| **Settings** | Org config, autonomy, budgets |

Platform admin remains separate (`/admin/*`).

Progressive disclosure: hide infra jargon from customers.

---

## 6. Honesty rules (non-negotiable)

- No hardcoded KPIs or fake viral scores  
- Missing integration → “Connect X to enable”  
- Forecasts = probabilities + uncertainty + evidence  
- Mock adapters labelled as mock in UI  
- Official vs observational algorithm evidence separated  

---

## 7. First vertical slice (Phase 1)

Ship a **buildable** Kernel foundation:

1. `src/kernel/` — types for Mission/Task/Tool/Policy  
2. ToolRegistry registering existing source + AI tools  
3. Policy helper mapping Autopilot + risk levels  
4. Observability fields on progress DTO (tools used, cost) without fake data  
5. Docs: `AGENT-KERNEL.md`  

Does **not** yet replace Ask UX or require a giant migration.

---

## 8. Related docs

- `docs/PLATFORM-AUDIT-V2.md`  
- `docs/ROADMAP-V2.md`  
- `docs/AGENT-KERNEL.md`  
- `docs/AI-OPERATING-SYSTEM.md`  
- `docs/AGENT-CATALOG.md`  
- `docs/DATA-MODEL-V2.md`  
- `docs/SYSTEM-OVERVIEW.md` (current production map)  
