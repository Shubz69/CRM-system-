# Research Intelligence Fabric

**Status:** Spec (Phase 3). Foundation: `src/adapters/sources/**`, ResearchJob/Source/Finding.

## Source Registry

Per provider: capabilities, auth, rate limits, availability, freshness, cost, compliance notes, last success/error.

Distinguish: **no data** vs **no permission**.

## Evidence

Query → Source → Snapshot → Finding/Claim → Citation → Confidence → Freshness → Contradiction.

Critic today: URL membership. Next: excerpt grounding + claim kinds.

## Honesty

Never invent citations. Prefer primary over secondary. Dedupe syndicated copies.
