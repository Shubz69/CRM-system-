export type EmbeddingProvider = {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
};

export class EmbeddingNotConfiguredError extends Error {
  constructor(message = "Embedding provider is not configured") {
    super(message);
    this.name = "EmbeddingNotConfiguredError";
  }
}
