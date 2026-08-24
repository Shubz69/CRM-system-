# Track 1 requests (Phase 15) — RESOLVED

Track 5 applied these items:

1. **Publishing Postgres sweep** — wired in `src/workers/index.ts` via `startPublishingSweep()` → `processDuePublishingJobs(20)` every `PUBLISHING_SWEEP_INTERVAL_MS` (default 30s). No new BullMQ worker.
2. **Domain events** — `CONTENT_PUBLISHED` / `CONTENT_PUBLISH_FAILED` / `CONTENT_PUBLISH_RECONCILIATION_REQUIRED` are in the catalogue and emitted from the publish path.
