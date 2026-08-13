import { KnowledgeDocStatus, Prisma } from "@prisma/client";
import {
  getEmbeddingProvider,
  isEmbeddingConfigured,
  toVectorLiteral,
} from "@/services/embeddings";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

const RRF_K = 60;
const DEFAULT_LIMIT = 5;
const LEXICAL_CANDIDATES = 20;
const SEMANTIC_CANDIDATES = 20;
const EMBED_BATCH = 32;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function scoreChunk(queryTokens: string[], content: string): number {
  const contentTokens = new Set(tokenize(content));
  let score = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) score += 1;
  }
  return score;
}

type RankedHit = { id: string; content: string; title: string; rank: number };

function reciprocalRankFusion(
  lists: RankedHit[][],
  limit: number,
): Array<{ content: string; title: string; score: number }> {
  const scores = new Map<string, { content: string; title: string; score: number }>();
  for (const list of lists) {
    for (const hit of list) {
      const add = 1 / (RRF_K + hit.rank);
      const existing = scores.get(hit.id);
      if (existing) {
        existing.score += add;
      } else {
        scores.set(hit.id, { content: hit.content, title: hit.title, score: add });
      }
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Lexical top-N in SQL — never loads all org chunks into Node.
 * Uses Postgres full-text search when the query has tokens; otherwise empty.
 */
async function lexicalTopN(input: {
  organisationId: string;
  query: string;
  limit: number;
}): Promise<RankedHit[]> {
  const tokens = tokenize(input.query);
  if (!tokens.length) return [];

  const rows = await prisma.$queryRaw<
    Array<{ id: string; content: string; title: string; rank: number }>
  >`
    SELECT
      c.id,
      c.content,
      d.title,
      ts_rank(
        to_tsvector('english', c.content),
        plainto_tsquery('english', ${input.query})
      )::float8 AS rank
    FROM "KnowledgeChunk" c
    INNER JOIN "KnowledgeDocument" d ON d.id = c."documentId"
    WHERE c."organisationId" = ${input.organisationId}
      AND d."organisationId" = ${input.organisationId}
      AND d.status = 'ACTIVE'
      AND to_tsvector('english', c.content) @@ plainto_tsquery('english', ${input.query})
    ORDER BY rank DESC
    LIMIT ${input.limit}
  `;

  // If FTS missed exact SKUs / prices, supplement with ILIKE on distinctive tokens.
  if (rows.length < Math.min(3, input.limit)) {
    const likeClauses = tokens.slice(0, 8).map((t) => Prisma.sql`c.content ILIKE ${`%${t}%`}`);
    const extras = await prisma.$queryRaw<
      Array<{ id: string; content: string; title: string }>
    >`
      SELECT c.id, c.content, d.title
      FROM "KnowledgeChunk" c
      INNER JOIN "KnowledgeDocument" d ON d.id = c."documentId"
      WHERE c."organisationId" = ${input.organisationId}
        AND d."organisationId" = ${input.organisationId}
        AND d.status = 'ACTIVE'
        AND (${Prisma.join(likeClauses, " OR ")})
      LIMIT ${input.limit}
    `;
    const seen = new Set(rows.map((r) => r.id));
    let rank = rows.length + 1;
    for (const extra of extras) {
      if (seen.has(extra.id)) continue;
      rows.push({ ...extra, rank: 1 / rank });
      rank += 1;
      if (rows.length >= input.limit) break;
    }
  }

  return rows.map((row, index) => ({
    id: row.id,
    content: row.content,
    title: row.title,
    rank: index + 1,
  }));
}

async function semanticTopN(input: {
  organisationId: string;
  queryEmbedding: number[];
  limit: number;
}): Promise<RankedHit[]> {
  const literal = toVectorLiteral(input.queryEmbedding);
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; content: string; title: string }>
  >(
    `
    SELECT c.id, c.content, d.title
    FROM "KnowledgeChunk" c
    INNER JOIN "KnowledgeDocument" d ON d.id = c."documentId"
    WHERE c."organisationId" = $1
      AND d."organisationId" = $1
      AND d.status = 'ACTIVE'
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $2::vector
    LIMIT $3
    `,
    input.organisationId,
    literal,
    input.limit,
  );

  return rows.map((row, index) => ({
    id: row.id,
    content: row.content,
    title: row.title,
    rank: index + 1,
  }));
}

async function groundingFallback(input: {
  organisationId: string;
  limit: number;
  already: Array<{ title: string }>;
}): Promise<Array<{ content: string; title: string; score: number }>> {
  const docs = await prisma.knowledgeDocument.findMany({
    where: {
      organisationId: input.organisationId,
      status: KnowledgeDocStatus.ACTIVE,
      OR: [
        { category: { contains: "pricing", mode: "insensitive" } },
        { category: { contains: "sop", mode: "insensitive" } },
        { category: { contains: "faq", mode: "insensitive" } },
        { category: { contains: "tone", mode: "insensitive" } },
        { category: { contains: "business", mode: "insensitive" } },
        { title: { contains: "pricing", mode: "insensitive" } },
        { title: { contains: "faq", mode: "insensitive" } },
      ],
    },
    select: { title: true, content: true },
    take: input.limit,
  });
  const out: Array<{ content: string; title: string; score: number }> = [];
  for (const doc of docs) {
    if (input.already.some((t) => t.title === doc.title)) continue;
    out.push({
      content: doc.content.slice(0, 800),
      title: doc.title,
      score: 0.05,
    });
    if (out.length >= input.limit) break;
  }
  return out;
}

/**
 * Hybrid retrieval: lexical top-N + semantic top-N, merged with reciprocal rank fusion.
 * Never drops lexical (prices, SKUs, exact policy wording).
 * If no embedding provider is configured, falls back to lexical-only and logs explicitly.
 */
export async function retrieveRelevantKnowledge(input: {
  organisationId: string;
  query: string;
  limit?: number;
}): Promise<{ chunks: string[]; documentTitles: string[]; mode: "hybrid" | "lexical" }> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const lexical = await lexicalTopN({
    organisationId: input.organisationId,
    query: input.query,
    limit: LEXICAL_CANDIDATES,
  });

  let mode: "hybrid" | "lexical" = "lexical";
  let semantic: RankedHit[] = [];

  if (isEmbeddingConfigured()) {
    try {
      const provider = getEmbeddingProvider();
      const [queryEmbedding] = await provider.embed([input.query]);
      if (queryEmbedding) {
        semantic = await semanticTopN({
          organisationId: input.organisationId,
          queryEmbedding,
          limit: SEMANTIC_CANDIDATES,
        });
        mode = "hybrid";
      }
    } catch (error) {
      logger.error("Semantic retrieval failed — continuing with lexical only", {
        organisationId: input.organisationId,
        message: error instanceof Error ? error.message : "unknown",
      });
      mode = "lexical";
    }
  } else {
    logger.warn(
      "Embedding provider is not configured — using lexical knowledge retrieval only (not silent). Set EMBEDDING_PROVIDER=openai to enable hybrid RAG.",
      { organisationId: input.organisationId },
    );
  }

  let top =
    mode === "hybrid"
      ? reciprocalRankFusion([lexical, semantic], limit)
      : lexical.slice(0, limit).map((h) => ({
          content: h.content,
          title: h.title,
          score: 1 / (RRF_K + h.rank),
        }));

  // Last-resort lexical path when FTS returned nothing: score a bounded SQL sample.
  if (top.length === 0) {
    const sample = await prisma.knowledgeChunk.findMany({
      where: {
        organisationId: input.organisationId,
        document: { organisationId: input.organisationId, status: KnowledgeDocStatus.ACTIVE },
      },
      select: {
        id: true,
        content: true,
        document: { select: { title: true } },
      },
      take: 50,
      orderBy: { createdAt: "desc" },
    });
    const queryTokens = tokenize(input.query);
    const scored = sample
      .map((c) => ({
        content: c.content,
        title: c.document.title,
        score: scoreChunk(queryTokens, c.content),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    top = scored;
  }

  if (top.length < 3) {
    const extra = await groundingFallback({
      organisationId: input.organisationId,
      limit: limit - top.length,
      already: top,
    });
    top = [...top, ...extra];
  }

  return {
    chunks: top.map((t) => `[${t.title}]\n${t.content}`),
    documentTitles: [...new Set(top.map((t) => t.title))],
    mode,
  };
}

export function chunkText(content: string, size = 800): string[] {
  const parts: string[] = [];
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return parts;
  let i = 0;
  while (i < normalized.length) {
    parts.push(normalized.slice(i, i + size));
    i += size;
  }
  return parts;
}

async function persistChunkEmbeddings(input: {
  organisationId: string;
  chunkIds: string[];
  texts: string[];
}): Promise<void> {
  if (!input.chunkIds.length) return;
  if (!isEmbeddingConfigured()) {
    logger.info("Skipping chunk embed on write — embedding provider not configured", {
      organisationId: input.organisationId,
      chunks: input.chunkIds.length,
    });
    return;
  }

  const provider = getEmbeddingProvider();
  for (let i = 0; i < input.chunkIds.length; i += EMBED_BATCH) {
    const ids = input.chunkIds.slice(i, i + EMBED_BATCH);
    const texts = input.texts.slice(i, i + EMBED_BATCH);
    const vectors = await provider.embed(texts);
    for (let j = 0; j < ids.length; j++) {
      const id = ids[j]!;
      const vector = vectors[j];
      if (!vector) continue;
      const literal = toVectorLiteral(vector);
      await prisma.$executeRawUnsafe(
        `
        UPDATE "KnowledgeChunk"
        SET embedding = $1::vector,
            "embeddingModel" = $2,
            "embeddedAt" = NOW()
        WHERE id = $3 AND "organisationId" = $4
        `,
        literal,
        provider.model,
        id,
        input.organisationId,
      );
    }
  }
}

async function replaceChunks(input: {
  organisationId: string;
  documentId: string;
  content: string;
}): Promise<void> {
  const chunks = chunkText(input.content);
  await prisma.knowledgeChunk.deleteMany({
    where: { documentId: input.documentId, organisationId: input.organisationId },
  });
  if (!chunks.length) return;

  await prisma.knowledgeChunk.createMany({
    data: chunks.map((chunkContent) => ({
      organisationId: input.organisationId,
      documentId: input.documentId,
      content: chunkContent,
    })),
  });

  const created = await prisma.knowledgeChunk.findMany({
    where: { documentId: input.documentId, organisationId: input.organisationId },
    select: { id: true, content: true },
    orderBy: { createdAt: "asc" },
  });

  try {
    await persistChunkEmbeddings({
      organisationId: input.organisationId,
      chunkIds: created.map((c) => c.id),
      texts: created.map((c) => c.content),
    });
  } catch (error) {
    logger.error("Failed to embed knowledge chunks on write — backfill will retry", {
      organisationId: input.organisationId,
      documentId: input.documentId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function updateKnowledgeDocument(input: {
  id: string;
  organisationId: string;
  title?: string;
  category?: string;
  content?: string;
  tags?: string[];
  status?: KnowledgeDocStatus;
}): Promise<string> {
  const existing = await prisma.knowledgeDocument.findFirst({
    where: { id: input.id, organisationId: input.organisationId },
  });
  if (!existing) {
    throw new Error("Document not found");
  }

  const nextContent = input.content ?? existing.content;
  const contentChanged = input.content !== undefined && input.content !== existing.content;

  if (contentChanged) {
    await prisma.$transaction([
      prisma.knowledgeVersion.create({
        data: {
          documentId: existing.id,
          version: existing.version,
          content: existing.content,
        },
      }),
      prisma.knowledgeDocument.update({
        where: { id: existing.id },
        data: {
          title: input.title ?? existing.title,
          category: input.category ?? existing.category,
          content: nextContent,
          tags: input.tags ?? existing.tags,
          version: existing.version + 1,
          status: input.status ?? existing.status,
        },
      }),
    ]);
    await replaceChunks({
      organisationId: input.organisationId,
      documentId: existing.id,
      content: nextContent,
    });
  } else {
    await prisma.knowledgeDocument.update({
      where: { id: existing.id },
      data: {
        title: input.title,
        category: input.category,
        tags: input.tags,
        status: input.status,
      },
    });
  }

  return existing.id;
}

export async function upsertKnowledgeDocument(input: {
  organisationId: string;
  title: string;
  category: string;
  content: string;
  tags?: string[];
}): Promise<string> {
  const existing = await prisma.knowledgeDocument.findFirst({
    where: {
      organisationId: input.organisationId,
      title: input.title,
    },
  });

  if (existing) {
    return updateKnowledgeDocument({
      id: existing.id,
      organisationId: input.organisationId,
      title: input.title,
      category: input.category,
      content: input.content,
      tags: input.tags,
      status: KnowledgeDocStatus.ACTIVE,
    });
  }

  const created = await prisma.knowledgeDocument.create({
    data: {
      organisationId: input.organisationId,
      title: input.title,
      category: input.category,
      content: input.content,
      tags: input.tags ?? [],
    },
  });

  await replaceChunks({
    organisationId: input.organisationId,
    documentId: created.id,
    content: input.content,
  });

  return created.id;
}

export async function archiveKnowledgeDocument(input: {
  id: string;
  organisationId: string;
}): Promise<void> {
  const existing = await prisma.knowledgeDocument.findFirst({
    where: { id: input.id, organisationId: input.organisationId },
  });
  if (!existing) throw new Error("Document not found");
  await prisma.knowledgeDocument.update({
    where: { id: existing.id },
    data: { status: KnowledgeDocStatus.ARCHIVED },
  });
}

export type EmbeddingBackfillResult = {
  organisationId: string;
  processed: number;
  remaining: number;
  cursor: string | null;
  skippedUnconfigured: boolean;
};

/**
 * Idempotent, resumable embedding backfill for one org.
 * Only rows with embedding IS NULL are processed.
 */
export async function backfillKnowledgeEmbeddings(input: {
  organisationId: string;
  cursor?: string | null;
  batchSize?: number;
}): Promise<EmbeddingBackfillResult> {
  if (!isEmbeddingConfigured()) {
    logger.warn(
      "Embedding backfill skipped — embedding provider is not configured (explicit, not silent)",
      { organisationId: input.organisationId },
    );
    return {
      organisationId: input.organisationId,
      processed: 0,
      remaining: 0,
      cursor: input.cursor ?? null,
      skippedUnconfigured: true,
    };
  }

  const batchSize = Math.min(Math.max(input.batchSize ?? 50, 1), 200);
  const provider = getEmbeddingProvider();

  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      organisationId: input.organisationId,
      embeddedAt: null,
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
    },
    select: { id: true, content: true },
    orderBy: { id: "asc" },
    take: batchSize,
  });

  if (chunks.length) {
    const vectors = await provider.embed(chunks.map((c) => c.content));
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vector = vectors[i];
      if (!vector) continue;
      await prisma.$executeRawUnsafe(
        `
        UPDATE "KnowledgeChunk"
        SET embedding = $1::vector,
            "embeddingModel" = $2,
            "embeddedAt" = NOW()
        WHERE id = $3
          AND "organisationId" = $4
          AND embedding IS NULL
        `,
        toVectorLiteral(vector),
        provider.model,
        chunk.id,
        input.organisationId,
      );
    }
  }

  const remaining = await prisma.knowledgeChunk.count({
    where: { organisationId: input.organisationId, embeddedAt: null },
  });

  const nextCursor = chunks.length ? chunks[chunks.length - 1]!.id : input.cursor ?? null;

  return {
    organisationId: input.organisationId,
    processed: chunks.length,
    remaining,
    cursor: nextCursor,
    skippedUnconfigured: false,
  };
}
