-- Perf: indexes for worker run logs + continuous-intel sweep (additive, no data change).
--
-- OpportunityDetectorRun (~2.5M rows) and ContinuousCollectionRun (~320k rows) are
-- large. A plain CREATE INDEX blocks writes to the table while it builds. To avoid
-- that on production, either:
--   (a) apply this after the run-log retention prune has shrunk the tables, or
--   (b) create the same indexes CONCURRENTLY by hand first (outside a transaction),
--       then `prisma migrate deploy` — IF NOT EXISTS makes this file a no-op:
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS "OpportunityDetectorRun_startedAt_idx" ON "OpportunityDetectorRun"("startedAt");
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS "OpportunityDetectorRun_organisationId_startedAt_idx" ON "OpportunityDetectorRun"("organisationId", "startedAt");
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS "ContinuousCollectionRun_createdAt_idx" ON "ContinuousCollectionRun"("createdAt");
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS "ContinuousCollectionRun_organisationId_observedAt_idx" ON "ContinuousCollectionRun"("organisationId", "observedAt");
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS "PostPerformance_organisationId_socialContentId_capturedAt_idx" ON "PostPerformance"("organisationId", "socialContentId", "capturedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PostPerformance_organisationId_socialContentId_capturedAt_idx" ON "PostPerformance"("organisationId", "socialContentId", "capturedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OpportunityDetectorRun_organisationId_startedAt_idx" ON "OpportunityDetectorRun"("organisationId", "startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OpportunityDetectorRun_startedAt_idx" ON "OpportunityDetectorRun"("startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ContinuousCollectionRun_organisationId_observedAt_idx" ON "ContinuousCollectionRun"("organisationId", "observedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ContinuousCollectionRun_createdAt_idx" ON "ContinuousCollectionRun"("createdAt");
