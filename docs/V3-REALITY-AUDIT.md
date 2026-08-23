# V3 Reality Audit — Agent Desk Production Intelligence OS

**Date:** 2026-08-23  
**Method:** Code + tests + workers inspected. Phase “done” labels from V2 are **not** treated as production-complete.  
**Rule:** UI/API/schema ≠ LIVE_E2E. Nothing is **PRODUCTION_VERIFIED** without live provider proof + isolation + retries + observability + cost + tests.

Maturity levels (exactly one per capability):

| Level | Meaning |
|-------|---------|
| **FOUNDATION** | Models / interfaces / docs / adapter stubs |
| **WORKING** | Real local app data path + automated tests |
| **LIVE_E2E** | Verified through the **real external provider/service**. A mocked provider, fixture, simulator, Playwright test, or local adapter is **not** LIVE_E2E. |
| **PRODUCTION_VERIFIED** | LIVE_E2E **plus** tenant isolation, permissions, retries/idempotency, recovery, observability, cost controls, degraded mode, relevant automated tests |

**WORKING** = local/application implementation with real application data + automated tests.

Do **not** write “LIVE_E2E at test level” — that state is invalid.

---

## Executive summary

V2 delivered an AI-native **architecture**. Most capabilities are **WORKING**. Hard gaps for a production OS:

1. **No publish worker** — `PublishingJob` never calls `adapter.publish()` in `src/workers/**`
2. **Embeddings default `none`** — lexical-only unless configured
3. **No DomainEvent outbox / Goal / Mission tables**
4. **SSRF-safe fetch / webhook timestamp replay** incomplete before Phase 11
5. **No PRODUCTION_VERIFIED** capability

---

## Capability matrix

| Capability | Data model | Service | API | UI | Worker | External provider | Live E2E | Tenant isolation | Permissions | Failure/retry | Observability | Cost metering | Automated tests | Documentation | **Maturity** | Missing work |
|------------|------------|---------|-----|----|--------|-------------------|----------|------------------|-------------|---------------|---------------|---------------|-----------------|---------------|--------------|--------------|
| Agent Kernel / Ask | AgentRun/Step/ToolCall | supervisor execute | `/api/ask` | `/ask` | agent-runs | Anthropic etc. | Partial (needs hosted worker) | Yes (org scope) | ask:use | Partial | Ask progress + AI Ops | AiExecution + spend gate | kernel + supervisor tests | AGENT-KERNEL | **WORKING** | Mission model; real tool executor; LIVE worker proof |
| Knowledge retrieval | KnowledgeDocument/Chunk | knowledge.ts | `/api/knowledge` | `/knowledge` | embedding backfill | OpenAI embeddings optional | No (default none) | Yes | knowledge:manage | Partial | Logs | UsageRecord | knowledge-hybrid, embeddings | KNOWLEDGE* | **WORKING** | Production embedding path; semantic E2E |
| Memory | Memory* models | agent-memory | via Ask | thin | — | — | No | Yes | ask:use | — | — | — | agent-memory | KNOWLEDGE-MEMORY-V2 | **WORKING** | UX; approval for truth promotion already |
| Research Fabric | ResearchJob/Source/Finding/Snapshot | research agent + adapters | Ask | Ask | agent-runs | YT/Reddit/Tavily/Apify | Keys optional | Yes | ask:use | Adapter errors recorded | capability-matrix | Apify AiExecution | source + research tests | INTEGRATION-CAPABILITY-MATRIX | **WORKING** | Live provider matrix; cost ops |
| Social Intel ingest | SocialCreator/Content/Metric | social-intelligence | — | thin | via research | Apify/research | No continuous | Yes | — | Soft-fail ingest | — | — | social-intelligence | ROADMAP leftovers | **WORKING** | Recurring scrape jobs |
| Trends + backtest | TrendCluster/Forecast/Outcome | trend-intelligence | `/api/trends` | Learning backtest | manual refresh | Derived | No | Yes | insights:read | Honest null metrics | — | — | trend-intelligence | TREND-FORECASTING | **WORKING** | Dashboard; scheduled jobs; outcomes history |
| Content OS pipeline | Content* models | content-os | `/api/content` | **No /content** | **No publish worker** | OAuth adapters unused | **No** | Partial | Kernel publish policy | Gate only | — | — | content-os | CONTENT-OPERATING-SYSTEM | **WORKING** | Workspace UI |
| **External publish** | PublishingJob | requestPublish / recordPublishResult | via content API | No | **MISSING** | IG/LI/TT adapters exist | **No** | Connection org check | social.publish approval | No executor retries | — | — | content-publish-isolation | CONTENT-OS | **FOUNDATION** | Worker → adapter.publish → external ID |
| CRM core | Contact/Lead/Pipeline | inbound-pipeline | inbox/pipeline/contacts | Yes | follow-ups (Postgres sweep) | ManyChat | Simulator / fixtures ≠ live provider | Strong tests | Role perms | Idempotent webhooks | Attention/FailedJob | Usage | inbound + org-isolation | — | **WORKING** | Operator ManyChat LIVE_E2E proof |
| CRM V2 | Company/Deal/CrmActivity | crm-v2 | companies/deals/360 | Yes | — | — | No Playwright | Org scope | leads:* | — | — | — | crm-v2 | CRM-V2 | **WORKING** | Deeper activities UX |
| Automation OS | AutomationRule/Execution/Approval | automation-os | automations/approvals | Yes + viewer | rule execution | — | No | Payload org assert | automations:manage | Approval gate | Audit | — | automation-os + isolation | AUTOMATION-OS | **WORKING** | Drag-drop builder; broader actions |
| Learning / evals | Feedback/Experiment/Candidate/Eval* | learning-os | `/api/learning/*` | `/learning` | — | — | No | Isolation tests | agent:manage | Promote blocked if fail | — | — | learning-os | LEARNING-OS / AI-EVALUATIONS | **WORKING** | Broader LLM eval suites |
| Entitlements + spend | Entitlement/UsageMeter/AiBudget | entitlements + spend-gate | `/api/entitlements` | via Learning/settings | — | — | No | Org meters | settings/org | Cap blocks | Spend breakdown | Yes | ai-spend + enterprise | ENTERPRISE-OS | **WORKING** | Billing provider |
| CoS / Home | — | enterprise-os briefing | `/api/chief-of-staff` | Ask strip | — | — | No | Org | ask:use | — | — | — | enterprise-os | ENTERPRISE-OS | **WORKING** | Opportunity-ranked Home |
| Command palette | — | — | — | ⌘K | — | — | No | — | Session | — | — | — | — | — | **WORKING** | Entity search |
| AI Ops | FailedJob/AgentRun/queues | getAiOpsSnapshot | `/api/admin/ai-ops` | `/admin/ai-ops` | observes | Redis | Needs Redis+worker | Platform | platform | — | Queue depths | AiExecution fails | — | WORKER | **WORKING** | Heartbeat history; SLOs |
| Hosted worker | — | workers/index | health | AI Ops | Yes | Redis | Deploy configs exist | — | — | SIGTERM | Logs | — | agent-runs-queue | WORKER / railway.toml | **WORKING** | Always-on prod proof |
| Messaging ManyChat | Conversation/Message | inbound + messaging adapter | webhooks | Inbox | follow-ups | ManyChat API | Token-gated | Secret resolution | inbox:* | Idempotency key | WebhookEvent | Usage | manychat-secrets | — | **WORKING** | Live E2E Playwright |
| Social OAuth | SocialConnection | social-connections | connect/callback | Integrations | — | Meta/LI/TT | Connect only | Encrypted creds | integrations:manage | Token refresh partial | — | — | social-oauth/db | SOCIAL_CONNECTIONS | **WORKING** | Publish E2E |
| Webhooks | WebhookEvent | inbound/booking | `/api/webhooks/*` | Admin | — | ManyChat/booking | Idempotent | Org resolve | Secrets | Dedupe | Failed jobs | Usage | org-isolation | SECURITY | **WORKING** | Timestamp replay (Phase 11) |
| Tenant isolation | organisationId everywhere | services | APIs | — | — | — | Automated tests (not a live provider) | **Strong** | Role matrix | — | Audit | — | org-isolation* | SECURITY | **WORKING** | Prod red-team / PRODUCTION_VERIFIED proof |
| Audit logging | AuditLog | audit.ts | admin audit | Yes | — | — | No | Scope ORG/PLATFORM | audit:read | — | Itself | — | audit-scope | SECURITY | **WORKING** | Full coverage |
| Secrets / crypto | IntegrationCredential | crypto AES-GCM | — | — | — | — | — | Encrypted at rest | — | — | Env warnings | — | — | SECURITY | **WORKING** → Phase 11 hardens | Rotation migration design |
| Domain events / outbox | **Absent** | — | — | — | — | — | No | — | — | — | — | — | — | DATA-MODEL deferred | **FOUNDATION** | Phase 12B |
| Goals / KPIs | **Absent** | — | — | — | — | — | No | — | — | — | — | — | — | DATA-MODEL deferred | **FOUNDATION** | Phase 13 |
| Mission persistence | AgentMission/Task/Checkpoint/Artifact/Outcome | mission-runtime | — | — | resume via Postgres | — | Resilience tests | Org-scoped | Permission helper | State machine + idempotency | Checkpoints | Budget fields | mission-runtime | REDIS-COST / ROADMAP-V3 | **WORKING** | Wire Ask→Mission; LIVE worker proof; Goal link (13) |

---

## Forbidden claims (still true)

Do **not** claim PRODUCTION_VERIFIED for:

- Content publish (no worker confirmation / external ID path)
- Forecast accuracy without `TrendForecastOutcome` rows
- Semantic knowledge with `EMBEDDING_PROVIDER=none`
- Live social metrics without provider sync jobs

---

## V3 phase order (next)

See [`ROADMAP-V3.md`](./ROADMAP-V3.md). Start with **Phase 11 — Security & Secret Hardening**, then Mission runtime, outbox, goals, publish vertical slice, etc.
