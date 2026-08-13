import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/adapters/embeddings", () => ({
  isEmbeddingConfigured: vi.fn(() => false),
  getEmbeddingProvider: vi.fn(() => {
    throw new Error("not configured");
  }),
  toVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
  EMBEDDING_DIMENSIONS: 1536,
}));

vi.mock("@/lib/db", () => {
  const knowledgeDocument = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const knowledgeChunk = {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  };
  return {
    prisma: {
      knowledgeDocument,
      knowledgeChunk,
      knowledgeVersion: { create: vi.fn() },
      $queryRaw: vi.fn(),
      $executeRawUnsafe: vi.fn(),
      $transaction: vi.fn(async (ops: unknown) => ops),
      __mocks: { knowledgeDocument, knowledgeChunk },
    },
  };
});

import { retrieveRelevantKnowledge } from "@/services/knowledge";
import { isEmbeddingConfigured } from "@/adapters/embeddings";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";

describe("retrieveRelevantKnowledge — unconfigured embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isEmbeddingConfigured).mockReturnValue(false);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        id: "c1",
        content: "Our investment packages start at 500",
        title: "Pricing",
        rank: 0.9,
      },
    ]);
    vi.mocked(prisma.knowledgeDocument.findMany).mockResolvedValue([]);
  });

  it("falls back to lexical and logs explicitly (never silently)", async () => {
    const result = await retrieveRelevantKnowledge({
      organisationId: "org_1",
      query: "how much for packages",
      limit: 5,
    });

    expect(result.mode).toBe("lexical");
    expect(result.chunks.join(" ")).toMatch(/investment packages/i);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/not configured/i),
      expect.objectContaining({ organisationId: "org_1" }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });
});
