import type { EmbeddingProvider } from "@/adapters/embeddings/types";
import { getEnv } from "@/lib/env";

const OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings";

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions: number;

  constructor(model: string, dimensions: number) {
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = getEnv().EMBEDDING_API_KEY || getEnv().OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY / EMBEDDING_API_KEY is not configured");
    }
    if (!texts.length) return [];

    const response = await fetch(OPENAI_EMBEDDING_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embeddings failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(
        `OpenAI embeddings returned ${data.length} vectors for ${texts.length} inputs`,
      );
    }
    return [...data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((row) => {
        if (!row.embedding || row.embedding.length !== this.dimensions) {
          throw new Error(
            `Unexpected embedding length ${row.embedding?.length ?? 0}; expected ${this.dimensions}`,
          );
        }
        return row.embedding;
      });
  }
}
