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

describe("retrieveRelevantKnowledge — embeddings auth/runtime failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isEmbeddingConfigured).mockReturnValue(true);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        id: "c1",
        content: "Workspace pricing starts at 500",
        title: "Pricing",
        rank: 0.9,
      },
    ]);
    vi.mocked(prisma.knowledgeDocument.findMany).mockResolvedValue([]);
  });

  it("degrades to lexical on embeddings 401 and keeps Ask usable", async () => {
    const { getEmbeddingProvider } = await import("@/adapters/embeddings");
    vi.mocked(getEmbeddingProvider).mockReturnValue({
      name: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      embed: vi.fn(async () => {
        throw new Error("Embeddings authentication failed (401)");
      }),
    } as never);

    const result = await retrieveRelevantKnowledge({
      organisationId: "org_1",
      query: "pricing packages",
      limit: 5,
    });

    expect(result.mode).toBe("lexical");
    expect(result.chunks.join(" ")).toMatch(/pricing/i);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/lexical only/i),
      expect.objectContaining({
        organisationId: "org_1",
        message: expect.stringMatching(/401/),
      }),
    );
    const logged = vi.mocked(logger.error).mock.calls[0]?.[1] as { message?: string };
    expect(String(logged?.message ?? "")).not.toMatch(/sk-[a-zA-Z0-9]/i);
    expect(String(logged?.message ?? "")).not.toMatch(/Incorrect API key/i);
  });

  it("degrades to lexical when semantic returns no vectors", async () => {
    const { getEmbeddingProvider } = await import("@/adapters/embeddings");
    vi.mocked(getEmbeddingProvider).mockReturnValue({
      name: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      embed: vi.fn(async () => []),
    } as never);

    const result = await retrieveRelevantKnowledge({
      organisationId: "org_1",
      query: "pricing packages",
      limit: 5,
    });

    expect(result.mode).toBe("lexical");
    expect(result.chunks.length).toBeGreaterThan(0);
  });
});
