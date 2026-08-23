# Enterprise product experience (Phase 10)

**Status:** Shipped — Chief of Staff Home strip, universal command bar → Ask, entitlements + meters, AI Ops console, hosted worker blueprints.

## Surfaces

| Surface | Path |
|---------|------|
| Chief of Staff briefing | `GET /api/chief-of-staff` · Home `/ask` strip |
| Command bar | ⌘/Ctrl+K · Ask prefill via `/ask?q=` |
| Entitlements | `GET\|POST /api/entitlements` · plan → capabilities |
| AI Ops | `/admin/ai-ops` · `GET /api/admin/ai-ops` |
| Hosted worker | `railway.toml` · `render.yaml` · `docs/WORKER.md` |
| Go Live | Worker+Redis marked required for Ask |

## Entitlements

- Plans: `standard` \| `pro` \| `enterprise` (`Organisation.plan`)
- Capabilities: research, imaging, social_listening, automations, content_publish, learning, ask
- `Entitlement` rows override plan defaults; `UsageMeter` + `UsageRecord` hold real quantities
- Research agent calls `assertEntitlement` + `recordMeteredUsage` — limits only when `limitValue` set and meter quantity exists
- Spend still gated by `OrganisationAiBudget` / `AiExecution` (unchanged)

## Honesty rules

- No invented uptime %, success rates, or usage gauges without ledger rows
- Queue depths come from BullMQ when Redis is up; otherwise `ok: false`
- CoS briefing only lists counts from live inbox / pipeline / approvals / failed jobs
- `GET /api/entitlements` → `spend.breakdown` is an `AiExecution` groupBy (provider/model/taskType) for the UTC month; rows with null `estimatedCost` are omitted, never estimated from hardcoded rates
