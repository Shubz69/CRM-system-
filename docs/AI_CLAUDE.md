# Claude (Anthropic) — primary AI

DM Intelligence uses **Anthropic Claude** as the primary and default AI provider.

OpenAI is **optional** and **not required**. The product builds and runs with `OPENAI_API_KEY` absent.

## Environment

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_DEFAULT_MODEL=claude-sonnet-4-20250514
ANTHROPIC_ECONOMY_MODEL=claude-3-5-haiku-latest
ANTHROPIC_ADVANCED_MODEL=claude-opus-4-20250514
```

## Architecture

- `src/lib/ai-models.ts` — central model IDs and task tiers
- `src/services/ai-router.ts` — task type → model selection + escalation
- `src/adapters/ai/anthropic.ts` — Claude Messages API (fetch; no SDK package)
- `src/schemas/ai.ts` — structured decision schema + normalization for the rule engine
- `src/services/ai-execution.ts` — `AiExecution` ledger + usage records

## Knowledge / embeddings

Knowledge retrieval uses **lexical (token) ranking** in Postgres (`src/services/knowledge.ts`).  
It does **not** call OpenAI embeddings. Claude answers only from retrieved approved chunks.

## Rule engine

Claude recommends actions. Autopilot + messaging windows + qualification thresholds decide what executes.
