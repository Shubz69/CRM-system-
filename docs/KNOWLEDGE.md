# Knowledge retrieval

DM Intelligence retrieves approved business knowledge with **lexical token ranking** over `KnowledgeDocument` / `KnowledgeChunk` rows in Postgres (`src/services/knowledge.ts`).

## Embeddings

**OpenAI embeddings are not used.** Knowledge works without `OPENAI_API_KEY`.

Claude receives the top ranked chunks and must not invent prices, policies, or availability outside that context. Missing facts create Knowledge Gaps (`KnowledgeRecommendation`).
