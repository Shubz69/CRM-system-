import { createHash } from "crypto";
import type { EmbeddingProvider } from "@/adapters/embeddings/types";

/**
 * Deterministic pseudo-embeddings for local/demo only.
 * Never used in production — only via allowMockTransports() in development/test.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock-embedding";
  readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const out = new Array<number>(this.dimensions).fill(0);
      const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const digest = createHash("sha256").update(token).digest();
        for (let i = 0; i < this.dimensions; i++) {
          out[i] += (digest[i % digest.length]! - 128) / 128;
        }
      }
      const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
      return out.map((v) => v / norm);
    });
  }
}
