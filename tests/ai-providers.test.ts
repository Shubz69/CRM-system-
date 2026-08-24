import { afterEach, describe, expect, it, vi } from "vitest";

describe("optional AI providers — fail closed when unconfigured, never a silent default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("Groq/Mistral/DeepSeek/Gemini throw a clear error when their key is missing", async () => {
    for (const key of ["GROQ_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY"]) {
      vi.stubEnv(key, "");
      delete process.env[key];
    }
    vi.resetModules();

    const { GroqProvider } = await import("@/adapters/ai/groq");
    const { MistralProvider } = await import("@/adapters/ai/mistral");
    const { DeepSeekProvider } = await import("@/adapters/ai/deepseek");
    const { GeminiProvider } = await import("@/adapters/ai/gemini");

    const request = { messages: [{ role: "user" as const, content: "hi" }] };
    await expect(new GroqProvider().complete(request)).rejects.toThrow(/GROQ_API_KEY/);
    await expect(new MistralProvider().complete(request)).rejects.toThrow(/MISTRAL_API_KEY/);
    await expect(new DeepSeekProvider().complete(request)).rejects.toThrow(/DEEPSEEK_API_KEY/);
    await expect(new GeminiProvider().complete(request)).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it("getAiProvider falls back to Anthropic when an optional provider is requested without its key", async () => {
    for (const key of ["GROQ_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY"]) {
      vi.stubEnv(key, "");
      delete process.env[key];
    }
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    vi.resetModules();
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();

    const { getAiProvider } = await import("@/adapters/ai");
    expect(getAiProvider("groq").name).toBe("anthropic");
    expect(getAiProvider("mistral").name).toBe("anthropic");
    expect(getAiProvider("deepseek").name).toBe("anthropic");
    expect(getAiProvider("gemini").name).toBe("anthropic");
  });

  it("getAiProvider returns the real optional provider once its key is set", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-test-key");
    vi.resetModules();

    const { getAiProvider } = await import("@/adapters/ai");
    expect(getAiProvider("groq").name).toBe("groq");
  });

  it("resolveModelForOptionalProvider honours env overrides and falls back to a documented default", async () => {
    vi.stubEnv("GROQ_ADVANCED_MODEL", "custom-model-override");
    vi.resetModules();

    const { resolveModelForOptionalProvider } = await import("@/lib/ai-models");
    expect(resolveModelForOptionalProvider("groq", "heavy")).toBe("custom-model-override");
    expect(resolveModelForOptionalProvider("groq", "cheap")).toBe("llama-3.1-8b-instant");
    expect(resolveModelForOptionalProvider("gemini", "balanced")).toBe("gemini-3.5-flash");
  });
});
