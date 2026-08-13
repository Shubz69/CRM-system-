import type { EmbeddingProvider } from "@/adapters/embeddings/types";

export type { EmbeddingProvider } from "@/adapters/embeddings/types";
export {
  getEmbeddingProvider,
  isEmbeddingConfigured,
  EmbeddingNotConfiguredError,
  EMBEDDING_DIMENSIONS,
} from "@/adapters/embeddings";

/** Format a float vector for pgvector literals. */
export function toVectorLiteral(values: number[]): string {
  if (!values.length) throw new Error("Embedding vector is empty");
  return `[${values.join(",")}]`;
}

export async function embedTextsOrThrow(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  if (!texts.length) return [];
  return provider.embed(texts);
}
