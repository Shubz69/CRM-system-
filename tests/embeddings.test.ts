import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";

describe("embedding provider factory", () => {
  beforeEach(() => {
    vi.resetModules();
    resetEnvCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
    vi.resetModules();
  });

  it("throws an explicit error when embedding provider is not configured", async () => {
    vi.stubEnv("EMBEDDING_PROVIDER", "none");
    resetEnvCache();
    const { getEmbeddingProvider, EmbeddingNotConfiguredError, isEmbeddingConfigured } =
      await import("@/adapters/embeddings");
    expect(isEmbeddingConfigured()).toBe(false);
    expect(() => getEmbeddingProvider()).toThrow(EmbeddingNotConfiguredError);
  });

  it("rejects unknown vendors instead of inventing fake vectors", async () => {
    vi.stubEnv("EMBEDDING_PROVIDER", "none");
    resetEnvCache();
    const { getEmbeddingProvider, EmbeddingNotConfiguredError } = await import(
      "@/adapters/embeddings"
    );
    expect(() => getEmbeddingProvider("cohere")).toThrow(EmbeddingNotConfiguredError);
    expect(() => getEmbeddingProvider("cohere")).toThrow(/Unknown EMBEDDING_PROVIDER/);
  });

  it("requires an API key for openai embeddings", async () => {
    vi.stubEnv("EMBEDDING_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("EMBEDDING_API_KEY", "");
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDING_API_KEY;
    resetEnvCache();
    const { getEmbeddingProvider, EmbeddingNotConfiguredError } = await import(
      "@/adapters/embeddings"
    );
    expect(() => getEmbeddingProvider("openai")).toThrow(/API_KEY/);
    expect(() => getEmbeddingProvider("openai")).toThrow(EmbeddingNotConfiguredError);
  });
});

describe("mock embedding provider", () => {
  it("returns deterministic unit-length vectors of the expected dimension", async () => {
    const { MockEmbeddingProvider } = await import("@/adapters/embeddings/mock");
    const { EMBEDDING_DIMENSIONS } = await import("@/adapters/embeddings");
    const provider = new MockEmbeddingProvider(EMBEDDING_DIMENSIONS);
    const [a] = await provider.embed(["investment packages"]);
    const [b] = await provider.embed(["investment packages"]);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a!.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
