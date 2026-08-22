# Data Model V2 — Proposed map

**Rule:** Audit before migrate. Use `prisma migrate deploy` only on real databases. Prefer extending existing models.

---

## Keep as-is (core)

Organisation, User, OrganisationMember, Contact*, Conversation*, Message*, Pipeline*, Lead*, Qualification*, LeadScore*, Booking, FollowUp, AgentConfiguration, Knowledge*, AgentRun, AgentStep, ToolCall, ResearchJob, ResearchSource, ResearchFinding, SocialConnection*, SocialPost, TrendSignal, Asset, Automation*, Campaign, Attribution, Integration*, WebhookEvent, AuditLog, Notification, FailedJob, UsageRecord, AiExecution, OrganisationAiBudget, DailyMetric, Report, SystemSetting, Autopilot fields on Organisation.

\* including related join/child tables already in schema.

---

## Extend (additive columns / JSON evolution)

| Model | Extensions |
|-------|------------|
| `AgentRun` | optional `missionId`, `evaluationSummary`, `policyDecisions` JSON |
| `ToolCall` | `riskLevel`, `toolVersion`, `idempotencyKey` |
| `ResearchFinding` | `confidence`, `freshnessScore`, `claimKind`, `flaggedUngrounded` ✅ |
| `ResearchSource` | `retrievedAt`, `contentHash`, `freshnessScore` ✅ |
| `ResearchSource` | `retrievedAt` vs `publishedAt` already partial — ensure both |
| `Campaign` | goals link, status lifecycle |
| `Organisation` | entitlement snapshot cache (optional) |

---

## Add (phased)

### Phase 1–2

- `Mission` (optional if AgentRun metadata sufficient initially)  
- Memory provenance fields on retrieval logs (or `MemoryEpisode`) ✅  
- `MemoryEntityFact`, `MemoryPerformanceOutcome`, `OrganisationPreference` ✅  

### Phase 3

- `ResearchProvider` / registry config (or SystemSetting + code) → capability matrix API ✅  
- `ResearchSourceSnapshot` ✅  
- `Evidence` / `Claim` if Finding insufficient — Finding extended for now  

### Phase 4–5

- `SocialContent` (canonical) + `SocialMetricSnapshot` ✅  
- `SocialCreator` ✅  
- `TrendCluster` / `TrendFeatureSnapshot` / `TrendForecast` / `TrendForecastOutcome` ✅  
- `AlgorithmChange` ✅  

### Phase 6

- `ContentOpportunity`, `ContentIdea`, `CreativeBrief`, `ContentPiece`, `ContentVersion`, `ContentVariant`, `ContentApproval`, `PublishingJob`, `PostPerformance` ✅  

### Phase 7

- `Company` / Account ✅  
- `Deal` (Opportunity) ✅ — coexists with `Lead`  
- `CrmActivity` ✅  
- Attribution `confidence` / `limitations` / `method` ✅  
- Organisation industry template fields ✅ 

### Phase 8–9

- `ApprovalRequest` ✅  
- AutomationRule `workflow` / `naturalLanguageSource` / `requiresApproval` ✅  
- `Experiment`  
- `Goal`, `Kpi`, `Initiative`  
- `RecommendationFeedback`  
- `AgentVersion` (candidate prompts)  

### Phase 10

- `Entitlement`, `UsageMeter`  
- Outbox `DomainEvent` table if needed  

---

## Explicitly do not add yet

- Separate graph database  
- Kafka  
- Hundreds of micro-tables for every adjective in the vision prompt  

---

## Indexing & retention

Plan indexes for: messages, metric snapshots, agent steps, tool calls, source snapshots, usage, audit.  
Define retention (already started via `OrganisationAgentRetention` / step detail clearing).
