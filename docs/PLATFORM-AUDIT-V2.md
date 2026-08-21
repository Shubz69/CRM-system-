# Platform Audit V2 — Agent Desk

**Date:** 2026-08-21  
**Repo:** `https://github.com/Shubz69/CRM-system-.git`  
**Product:** Agent Desk (`agent-desk`)  
**Next.js:** 16.3 (see `AGENTS.md` / `CLAUDE.md` — do not assume older Next.js APIs)  
**Method:** Repository-grounded audit of docs, Prisma schema, agents, services, adapters, workers, navigation, and tests. **No production schema was mutated for this audit.**

---

## Executive summary

Agent Desk today is a **strong multi-tenant AI sales desk + Ask research workspace**, not yet an AI Business Operating System.

| Strength | Gap |
|----------|-----|
| Org isolation, encrypted credentials, AI spend gates, audit logs | No Account/Company, Opportunity/Deal, Goal/KPI, Entitlement |
| Linear Ask pipeline (research → analyst → critic) with evidence DB | No Agent Kernel (missions, tool registry, evals, approvals graph) |
| ManyChat inbound → Lead → Autopilot / Attention | No Content OS, Campaign UX, revenue attribution product |
| Worker + BullMQ + Vercel split understood | Worker still often local; long jobs fail without it |
| Social Apify + OAuth connections started | No Social Intelligence Graph, forecasts, algorithm evidence store |
| Knowledge RAG exists | **Not wired into Ask agents** |

**Transformation principle:** Keep the CRM as system of record; grow a shared Agent Kernel and Research Fabric on top; do **not** giant-rewrite or ship AI theatre.

---

## Classification legend

- **KEEP** — production-quality; retain and extend  
- **REFACTOR** — right idea; insufficient architecture  
- **EXPAND** — capable seed; needs major capability growth  
- **REPLACE** — will block the target OS if left as-is  
- **MISSING** — required by target product, absent  
- **RISK** — security, cost, reliability, compliance, product honesty  

---

## Domain-by-domain audit

### A. Tenancy, auth, security

| | |
|--|--|
| **Current** | `Organisation`, `User`, `OrganisationMember`, NextAuth credentials JWT, bcrypt, lockout, AES-GCM credentials, timing-safe webhooks, org-scoped queries |
| **Files** | `src/lib/auth.ts`, `src/lib/session.ts`, `src/lib/permissions.ts`, `src/lib/db.ts`, `docs/SECURITY.md`, `docs/ADMIN.md` |
| **KEEP** | Org isolation, encryption, RBAC roles, audit log, password reset + bootstrap |
| **REFACTOR** | JWT workspace recheck under load (partially hardened); permission matrix → capability entitlements later |
| **EXPAND** | Agent capability permissions, tool scopes, data export/deletion policies, secret rotation UX |
| **MISSING** | Entitlement/SKU service; formal retention/deletion product UX; SSRF policy for fetch tools |
| **RISK** | Pool exhaustion / invalid env still break sessions; worker + app share DB; PII in AI logs if not careful |
| **Migration impact** | Low if additive |
| **Infra** | Supabase pooler strategy must stay |

### B. CRM (contacts, inbox, pipeline)

| | |
|--|--|
| **Current** | Contact, Conversation, Message, Pipeline/Stage, Lead, qualification, scoring, booking, follow-ups, tags, notes |
| **Files** | `prisma/schema.prisma`, `src/services/*` inbound/pipeline, `/inbox`, `/pipeline`, `/contacts` |
| **KEEP** | Full DM→Lead loop, scoring events, Autopilot gates, Attention queue |
| **REFACTOR** | Treat `Lead` as transitional; introduce Opportunity/Deal without discarding leads |
| **EXPAND** | Customer 360, activities, tasks, SLAs, custom fields framework |
| **REPLACE** | Nothing immediately — do not delete Lead |
| **MISSING** | Account/Company, Opportunity/Deal, multi-touch attribution UX, industry templates |
| **RISK** | Overfitting to Instagram setter workflows |

### C. Ask / Agent runtime

| | |
|--|--|
| **Current** | Agent registry; deterministic supervisor; linear execute; `AgentRun`/`AgentStep`/`ToolCall`; spend/wall-clock limits; BullMQ enqueue |
| **Files** | `src/agents/**`, `src/services/agent-runs.ts`, `src/workers/agent-runs-processor.ts` |
| **KEEP** | Registry contract, userFacing labels, spend gates, clarification + prompt confirm, critic merge, progress API |
| **REFACTOR** | Enable LLM planner only behind flag + evals; unify “tools” vs “agents” |
| **EXPAND** → **Agent Kernel** | Missions, tasks, deps, parallel research, approvals, cancellation UX, streaming, observability |
| **REPLACE** | Ad-hoc tool recording without schemas (evolve, don’t throw away rows) |
| **MISSING** | Mission model, tool registry, eval harness, knowledge-in-context, agent-to-agent handoff protocol |
| **RISK** | Cost of multi-agent without gating; empty answers if critic/analyst miswired (partially fixed) |

### D. Research & social listening

| | |
|--|--|
| **Current** | ResearchJob/Source/Finding; YouTube, Reddit, web (Tavily/Exa); Apify IG/LI/TikTok/Twitter/Threads; social listening agent; analyst social pack |
| **Files** | `src/adapters/sources/**`, `src/agents/research.ts`, `analyst.ts`, `social-listening.ts`, `critic.ts` |
| **KEEP** | Adapter interface, caching, rate limits, Apify billing hooks, evidence excerpts, URL critic |
| **REFACTOR** | Source registry with capability matrix; fix Twitter/Threads wiring vs `ALL_ADAPTERS`; rename misleading `stubs.ts` |
| **EXPAND** | Source snapshots, claim confidence, freshness, clustering, provider availability states |
| **MISSING** | Research Source Registry product, AlgorithmChange store, TrendForecast + backtests |
| **RISK** | Fabricating viral certainty; Apify cost spikes; non-official scraping claims |

### E. Knowledge

| | |
|--|--|
| **Current** | Documents, versions, chunks, embeddings, recommendations with approval |
| **Files** | `src/services/knowledge.ts`, `docs/KNOWLEDGE.md` |
| **KEEP** | Hybrid retrieval foundation, recommendation approval |
| **EXPAND** | Episodic / entity / performance / preference memory; provenance |
| **MISSING** | Agent wiring into Ask/supervisor context construction |
| **RISK** | Stale knowledge treated as truth without provenance |

### F. Automations & Autopilot

| | |
|--|--|
| **Current** | AutomationRule/Execution; AutopilotMode; per-capability automatic/approval_required/disabled |
| **Files** | `src/services/automations.ts`, `src/services/autopilot.ts`, `src/lib/autopilot-config.ts` |
| **KEEP** | Autopilot modes + Attention; follow-up approval default |
| **EXPAND** | Automation OS (NL → visible workflow); agent steps as actions; richer triggers |
| **MISSING** | Visual builder; risk-tiered tool actions; outbox events |
| **RISK** | Auto-outbound without approval |

### G. Social connections & publishing

| | |
|--|--|
| **Current** | SocialConnection + credentials; Instagram/LinkedIn/TikTok OAuth adapters |
| **Files** | `docs/SOCIAL_CONNECTIONS.md`, `src/adapters/social/**`, `src/services/social-connections.ts` |
| **KEEP** | Separation of OAuth publish vs Apify listen |
| **EXPAND** | Capability matrix per platform; schedule/publish jobs; metric snapshots |
| **MISSING** | ContentPiece, PublishingJob, PostPerformance time series |
| **RISK** | Claiming DM/publish capabilities APIs don’t support |

### H. Content & campaigns

| | |
|--|--|
| **Current** | Ask “write content” outcome; Campaign + Attribution models; Asset images; Insights suggestions |
| **KEEP** | Campaign/Attribution seed; Asset for imaging |
| **EXPAND** | Full Content OS lifecycle |
| **MISSING** | ContentOpportunity, ContentPiece, calendar, variants, compliance gate, measurement loop |
| **RISK** | AI theatre content calendars without data |

### I. Analytics, goals, revenue

| | |
|--|--|
| **Current** | DailyMetric, Report, Insights, AI Usage admin |
| **EXPAND** | Goal/KPI graph, revenue attribution with confidence |
| **MISSING** | Goal, KPI, Experiment, forecast backtest metrics, recommendation feedback |
| **RISK** | Fake confidence scores |

### J. Infrastructure

| | |
|--|--|
| **Current** | Vercel app, Supabase Postgres, Upstash Redis, BullMQ worker, Vercel cron fallback |
| **Docs** | `docs/SYSTEM-OVERVIEW.md`, `WORKER.md`, `VERCEL.md`, `SUPABASE.md` |
| **KEEP** | Split: enqueue on Vercel, execute on worker; pooler URL strategy |
| **EXPAND** | Hosted worker as first-class; more queues (ingestion, forecast, publish) |
| **RISK** | Ask broken without worker; Redis misconfiguration; connection_limit=1 legacy |
| **Infra impact** | Any long research must stay off Vercel request path |

### K. Frontend / IA

| | |
|--|--|
| **Current** | Object-centric nav + Ask outcome cards; Setup Assistant |
| **Files** | `src/lib/navigation.ts`, `src/app/(app)/**` |
| **KEEP** | Ask as natural-language surface; progressive details |
| **REFACTOR** | Navigation toward outcomes (Home, Opportunities, CRM, Content, Intelligence, Agents…) |
| **MISSING** | Universal command bar; Chief of Staff home; Opportunities hub |
| **RISK** | Exposing infra jargon; flashy empty dashboards |

### L. Commercial / entitlements

| | |
|--|--|
| **Current** | `Organisation.plan` string; AI budgets; agent limits; UsageRecord |
| **MISSING** | Entitlement service, metering for research/publish/forecast, plan capabilities |
| **RISK** | Plan checks scattered in UI |

---

## Cross-cutting KEEP / REFACTOR / EXPAND / REPLACE / MISSING / RISK

### KEEP (do not throw away)

- Multi-tenant Prisma model + org filters  
- NextAuth + permissions  
- Encryption + webhook security  
- AI spend gate + AiExecution  
- AgentRun / AgentStep / ToolCall persistence  
- ResearchJob / Source / Finding evidence chain  
- Autopilot + Attention  
- Knowledge docs/chunks  
- BullMQ worker architecture  
- Adapter pattern for AI / sources / messaging  

### REFACTOR

- Deterministic planner ↔ optional LLM planner with evals  
- Source adapter registry + capability matrix  
- Critic → richer evidence verification over time  
- Nav IA → outcome-based without removing routes abruptly  
- Lead → Opportunity coexistence  

### EXPAND

- Agent Kernel, Memory V2, Research Fabric, Social Graph, Content OS, Automation OS, Goals, Entitlements  

### REPLACE (carefully, over time)

- Treating “agent” as only a Zod+execute function without tools/policy (replace **conceptually** via Kernel wrapper, keep implementations)  
- Using Ask progress as the only observability surface (add AI Ops admin)  

### MISSING (highest priority for OS vision)

1. Agent Kernel (missions, tools, policy, observability)  
2. Knowledge wired into agent context  
3. Research Source Registry + claim confidence  
4. Social metric time series + trend forecast + backtest  
5. Content OS + Opportunities  
6. Account / Opportunity CRM depth  
7. Entitlements + hosted worker as product requirement  
8. Evaluation framework  

### RISK register

| Risk | Mitigation |
|------|------------|
| AI theatre / fake forecasts | No numbers without data; show “connect X” |
| Cost blow-ups (Apify + Claude) | Budgets, caching, cheap routing, mission caps |
| Prompt injection via web/social | Treat tool output as data; brand guardian; sanitise |
| Tenant leakage | Keep orgId on every write; isolation tests |
| Schema push to prod | Never `db push` on Supabase; migrate deploy only |
| Worker absent | Health + UI messaging; hosted worker |
| Over-orchestration | Simple tasks stay single-agent |

---

## Mapping to implementation phases

| Phase | Audit focus |
|-------|-------------|
| 0 | This document |
| 1 | Agent Kernel wrapping existing agents |
| 2 | Knowledge & Memory → wire into Ask |
| 3 | Research Fabric / registry / evidence |
| 4–5 | Social graph + trends/algorithms |
| 6 | Content OS |
| 7 | CRM V2 (Account/Opportunity) |
| 8 | Automation OS |
| 9 | Learning / evals / backtests |
| 10 | Enterprise UX / entitlements / onboarding |

See `docs/ROADMAP-V2.md` and `docs/TARGET-ARCHITECTURE-V2.md`.
