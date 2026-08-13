-- Hybrid knowledge retrieval: pgvector embeddings on KnowledgeChunk.
-- Lexical retrieval remains available when no embedding provider is configured.

CREATE EXTENSION IF NOT EXISTS vector;

-- Denormalise organisationId onto chunks (required for org-scoped SQL).
ALTER TABLE "KnowledgeChunk" ADD COLUMN "organisationId" TEXT;
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embedding" vector(1536);
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embeddingModel" TEXT;
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embeddedAt" TIMESTAMP(3);

UPDATE "KnowledgeChunk" AS c
SET "organisationId" = d."organisationId"
FROM "KnowledgeDocument" AS d
WHERE c."documentId" = d."id"
  AND c."organisationId" IS NULL;

-- Orphan safety: should not happen; fail loudly if any remain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "KnowledgeChunk" WHERE "organisationId" IS NULL) THEN
    RAISE EXCEPTION 'KnowledgeChunk rows missing organisationId after backfill';
  END IF;
END $$;

ALTER TABLE "KnowledgeChunk" ALTER COLUMN "organisationId" SET NOT NULL;

CREATE INDEX "KnowledgeChunk_organisationId_idx" ON "KnowledgeChunk"("organisationId");
CREATE INDEX "KnowledgeChunk_organisationId_embeddedAt_idx" ON "KnowledgeChunk"("organisationId", "embeddedAt");

ALTER TABLE "KnowledgeChunk"
  ADD CONSTRAINT "KnowledgeChunk_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HNSW for cosine similarity. Partial index skips null embeddings.
CREATE INDEX "KnowledgeChunk_embedding_hnsw_idx"
  ON "KnowledgeChunk"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;
