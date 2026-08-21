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

1. Inject knowledge retrieval into Ask supervisor context.  
2. Add provenance (source id, retrievedAt, score) to context packets.  
3. Never silent-promote research findings into KnowledgeDocument.
