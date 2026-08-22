# Research Intelligence Fabric

**Status:** Phase 3 in progress. Foundation: `src/adapters/sources/**`, ResearchJob/Source/Finding/Snapshot.

## Source Registry

Runtime matrix: `GET /api/integrations/capability-matrix` (`buildIntegrationCapabilityMatrix`).

Per provider: capabilities, auth hints, configured vs requires credentials vs unsupported. Distinguishes **no data** vs **no permission/credentials**.

## Evidence path

Query → Source (+ `retrievedAt`, `contentHash`, `freshnessScore`) → **SourceSnapshot** → Finding/Claim (`claimKind`, `confidence`, `freshnessScore`) → Critic (URL + **excerpt grounding**) → Report.

## Critic

1. Citation URL must appear in collected sources for the job.  
2. Evidence excerpt (preferred) or claim tokens must be grounded in stored source content.  
3. Sets `flaggedUnsupported` / `flaggedUngrounded` on `ResearchFinding`.

## Parallel search

`searchConfiguredSources` already fans out adapters via `mapPool` (Kernel tool `sources.search`).

## Honesty

Never invent citations. Prefer primary (`OFFICIAL`) over secondary. Dedupe via content hash where useful.
