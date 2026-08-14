import { MockEmbeddingProvider } from "@/adapters/embeddings/mock";
import { OpenAiEmbeddingProvider } from "@/adapters/embeddings/openai";
import {
  EmbeddingNotConfiguredError,
  type EmbeddingProvider,
} from "@/adapters/embeddings/types";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { allowMockTransports } from "@/lib/runtime";

/** Must match KnowledgeChunk.embedding vector(1536) and migration. */
export const EMBEDDING_DIMENSIONS = 1536;

export { EmbeddingNotConfiguredError } from "@/adapters/embeddings/types";
export type { EmbeddingProvider } from "@/adapters/embeddings/types";

/**
 * Resolve embedding provider.
 * Not hard-coded to one vendor — selected via EMBEDDING_PROVIDER.
 * Unconfigured → explicit error (callers that want lexical fallback must check isEmbeddingConfigured).
 */
export function getEmbeddingProvider(override?: string): EmbeddingProvider {
  const env = getEnv();
  const configured = (override || env.EMBEDDING_PROVIDER || "none").toLowerCase();
  const model = env.EMBEDDING_MODEL || "text-embedding-3-small";

  if (configured === "none" || configured === "") {
    throw new EmbeddingNotConfiguredError(
      "Embedding provider is not configured (set EMBEDDING_PROVIDER=openai|mock)",
    );
  }

  if (configured === "openai") {
    const key = env.EMBEDDING_API_KEY || env.OPENAI_API_KEY;
    if (!key) {
      throw new EmbeddingNotConfiguredError(
        "EMBEDDING_PROVIDER=openai requires EMBEDDING_API_KEY or OPENAI_API_KEY",
      );
    }
    return new OpenAiEmbeddingProvider(model, EMBEDDING_DIMENSIONS);
  }

  if (configured === "mock") {
    if (!allowMockTransports()) {
      throw new EmbeddingNotConfiguredError(
        "EMBEDDING_PROVIDER=mock is not allowed in production",
      );
    }
    logger.warn("Using mock embedding provider (non-production/demo only)");
    return new MockEmbeddingProvider(EMBEDDING_DIMENSIONS);
  }

  throw new EmbeddingNotConfiguredError(
    `Unknown EMBEDDING_PROVIDER="${configured}". Supported: openai, mock, none`,
  );
}

export function isEmbeddingConfigured(): boolean {
  try {
    getEmbeddingProvider();
    return true;
  } catch (error) {
    if (error instanceof EmbeddingNotConfiguredError) return false;
    throw error;
  }
}
