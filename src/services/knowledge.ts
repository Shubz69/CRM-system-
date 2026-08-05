import { KnowledgeDocStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

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

/**
 * Lightweight lexical retrieval — returns only relevant knowledge snippets.
 * Does not embed; suitable for Phase 1 and keeps the AI grounded.
 */
export async function retrieveRelevantKnowledge(input: {
  organisationId: string;
  query: string;
  limit?: number;
}): Promise<{ chunks: string[]; documentTitles: string[] }> {
  const docs = await prisma.knowledgeDocument.findMany({
    where: {
      organisationId: input.organisationId,
      status: KnowledgeDocStatus.ACTIVE,
    },
    include: { chunks: true },
  });

  const queryTokens = tokenize(input.query);
  const scored: Array<{ content: string; title: string; score: number }> = [];

  for (const doc of docs) {
    if (doc.chunks.length === 0) {
      const s = scoreChunk(queryTokens, `${doc.title} ${doc.content}`);
      if (s > 0 || queryTokens.length === 0) {
        scored.push({
          content: doc.content.slice(0, 1200),
          title: doc.title,
          score: s || 0.1,
        });
      }
      continue;
    }

    for (const chunk of doc.chunks) {
      const s = scoreChunk(queryTokens, chunk.content);
      if (s > 0) {
        scored.push({ content: chunk.content, title: doc.title, score: s });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, input.limit ?? 5);

  // Always include a small amount of business/pricing grounding docs if present
  if (top.length < 3) {
    for (const doc of docs) {
      if (/pricing|sop|tone|faq|business/i.test(doc.category) || /pricing|sop|tone|faq/i.test(doc.title)) {
        if (!top.some((t) => t.title === doc.title)) {
          top.push({
            content: doc.content.slice(0, 800),
            title: doc.title,
            score: 0.05,
          });
        }
      }
      if (top.length >= (input.limit ?? 5)) break;
    }
  }

  return {
    chunks: top.map((t) => `[${t.title}]\n${t.content}`),
    documentTitles: [...new Set(top.map((t) => t.title))],
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
    const version = existing.version + 1;
    await prisma.$transaction([
      prisma.knowledgeVersion.create({
        data: {
          documentId: existing.id,
          version: existing.version,
          content: existing.content,
        },
      }),
      prisma.knowledgeChunk.deleteMany({ where: { documentId: existing.id } }),
      prisma.knowledgeDocument.update({
        where: { id: existing.id },
        data: {
          content: input.content,
          category: input.category,
          tags: input.tags ?? existing.tags,
          version,
          status: KnowledgeDocStatus.ACTIVE,
        },
      }),
    ]);

    const chunks = chunkText(input.content);
    if (chunks.length) {
      await prisma.knowledgeChunk.createMany({
        data: chunks.map((content) => ({ documentId: existing.id, content })),
      });
    }
    return existing.id;
  }

  const created = await prisma.knowledgeDocument.create({
    data: {
      organisationId: input.organisationId,
      title: input.title,
      category: input.category,
      content: input.content,
      tags: input.tags ?? [],
      chunks: {
        create: chunkText(input.content).map((content) => ({ content })),
      },
    },
  });
  return created.id;
}
