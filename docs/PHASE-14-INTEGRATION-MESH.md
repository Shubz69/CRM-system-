# Phase 14 — Integration Mesh + Tool/Skill Platform

**Framework maturity: WORKING** (local/DB/tests). Individual providers keep their own maturity — do **not** claim mesh-wide LIVE_E2E.

## Inventory (wrap, don’t rebuild)

| Provider | Auth | Product role | Maturity |
|---|---|---|---|
| ManyChat | API token + webhook secret | DMs in/out | WORKING (LIVE_E2E only with real token+secret round-trip) |
| Instagram OAuth | OAuth | Connect + publish adapter | WORKING connect; publish E2E = Phase 15 |
| LinkedIn OAuth | OAuth | Connect + publish adapter | WORKING connect; no refresh; publish E2E = Phase 15 |
| TikTok OAuth | OAuth | Connect + publish adapter | WORKING connect; publish E2E = Phase 15 |
| YouTube | API key | Research search | WORKING |
| Tavily/Exa | API key | Web search | WORKING |
| Apify | API token | Licensed public listen | WORKING |
| Booking | Webhook secret + URL | Link + webhook | WORKING (not calendar OAuth) |
| Email SMTP | Env | Report send | WORKING |
| AI providers | Env keys | Completions | WORKING (separate from business connectors) |

## Architecture

Code catalogue: `src/services/connectors/catalogue.ts`  
Capability eval: `capabilities.ts` (persists `ConnectorCapabilityState` with provenance)  
Sync: `sync.ts` (`SyncCursor`, `SyncRun`, `ExternalObjectMapping`)  
Resilience: `resilience.ts` (429 backoff + circuit breaker)  
Authz: `authorize.ts` (tool + capability + rate limit + circuit)  
Skills: `skills.ts` (versioned SkillDefinition)  
Reconciliation: `reconciliation.ts`  
MCP: `mcp.ts` (optional deny-by-default boundary — not required)

Agent path: **Agent → Tool Registry → Policy → Connector Operation → Provider**

## Capability states

AVAILABLE | CONNECTED | AUTH_REQUIRED | SCOPE_REQUIRED | APPROVAL_REQUIRED | RESTRICTED | DEGRADED | UNSUPPORTED | DISABLED

Connected account ≠ all capabilities available.

## UI

`/integrations` → Connector mesh panel (`GET/POST /api/integrations/mesh`)

## Events

INTEGRATION_* / SYNC_* catalogue types; deal PATCH emits DEAL_WON / DEAL_LOST / DEAL_STAGE_CHANGED.

## Known limitations (preserved)

- Incomplete DomainEvent coverage for many CRM/messaging mutations
- Playwright skipped without E2E credentials
- No production multi-worker soak
- Phase 15 live publishing worker not implemented
- Provider restrictions vary (see catalogue `commercialRestrictions`)
- No provider labelled LIVE_E2E without real provider verification
