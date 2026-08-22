# Knowledge & Memory V2

**Status:** Spec (Phase 2). Current: `docs/KNOWLEDGE.md` + `src/services/knowledge.ts`.

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
4. [ ] Episodic / entity / performance / preference memory models.
5. [ ] Never silent-promote research findings into KnowledgeDocument.
