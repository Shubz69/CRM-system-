# Research Intelligence Fabric

**Status:** Phase 3 in progress. Foundation: `src/adapters/sources/**`, ResearchJob/Source/Finding/Snapshot.

## Ask results (customer-facing)

Default Ask UI returns **four answer types** for every workspace — not a freeform wall of source cards:

1. **Strategy** — what to do and why
2. **Scripts** — hooks, captions, talking points
3. **Posting plan** — cadence, formats, timing
4. **Monetization** — how to get paid / convert attention

Research still gathers sources internally for quality and never invents URLs. The default Ask view does **not** list source cards. Evidence is opt-in via “Show evidence”.

Default / Quick Ask aims to finish a thorough search plus these four sections inside **60 seconds**. If the budget is hit, Ask still shapes the four answers from whatever was gathered — it must not dump “sources gathered before the limit”.

Growth/content Asks also attach **example AI video briefs** (title, hook, shot list, length). Generation fails closed with `AUTH_REQUIRED` / not-configured unless `VIDEO_PROVIDER` is wired — there is no video adapter in-repo yet.

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
