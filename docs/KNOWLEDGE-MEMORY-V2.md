# Knowledge & Memory V2

**Status:** Phase 2 models landed. Current: `docs/KNOWLEDGE.md` + `src/services/knowledge.ts` + `src/services/agent-memory.ts`.

## Memory kinds

| Kind | Purpose | Promotion |
|------|---------|-----------|
| Knowledge | Approved company truth | Human/Knowledge Architect approval |
| Episodic | Prior runs/interactions | Auto, TTL |
| Entity | Facts about contacts/companies/topics | Provenance required |
| Working | Current mission context | Ephemeral |
| Performance | Campaigns/experiments outcomes | Measured |
| Preference | Tone/operating prefs | Admin |

## Near-term work

1. [x] Inject knowledge retrieval into Ask supervisor context.
2. [x] Add provenance (document titles, retrieval mode) via `knowledge.retrieve` ToolCall.
3. [x] Never invent URLs from internal docs — analyst/research treat knowledge as focus only.
4. [x] Episodic / entity / performance / preference memory models (`MemoryEpisode`, `MemoryEntityFact`, `MemoryPerformanceOutcome`, `OrganisationPreference`).
5. [x] Never silent-promote research findings into KnowledgeDocument (`assertKnowledgePromotionPolicy` on Ask saves).

## Runtime behaviour

- On Ask complete/partial: write a `MemoryEpisode` (90-day TTL).
- Before steps: retrieve relevant episodes + admin preferences via `memory.retrieve`.
- Entity facts require `provenance.sourceType`; default status `CANDIDATE`.
- Performance outcomes are measured rows only (no estimated metrics).
- Preferences are admin-set keys (e.g. `tone`, `operatingStyle`).
- Ask → Save to Knowledge stays **INACTIVE**; ACTIVE from Ask tags is rejected at API.
