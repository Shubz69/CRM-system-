import { describe, expect, it, beforeEach } from "vitest";
import {
  getAiProviderConfigPreflight,
  isAiProviderAuthError,
  RESEARCH_SYNTHESIS_FAILED_CUSTOMER,
} from "@/services/ai-provider-preflight";

describe("AI provider preflight", () => {
  beforeEach(() => {
    // leave process env as-is; only assert pure helpers
  });

  it("detects auth failures without naming customer-facing providers in the constant", () => {
    expect(isAiProviderAuthError("Anthropic request failed (401): authentication_error")).toBe(
      true,
    );
    expect(isAiProviderAuthError("ANTHROPIC_API_KEY is not configured")).toBe(true);
    expect(isAiProviderAuthError("temporary network glitch")).toBe(false);
    expect(RESEARCH_SYNTHESIS_FAILED_CUSTOMER).not.toMatch(/anthropic|claude|api key|401/i);
  });

  it("keeps structured-extraction customer copy provider-neutral", async () => {
    const { RESEARCH_STRUCTURED_EXTRACTION_FAILED_CUSTOMER } = await import(
      "@/services/ai-provider-preflight"
    );
    expect(RESEARCH_STRUCTURED_EXTRACTION_FAILED_CUSTOMER).not.toMatch(
      /anthropic|claude|zod|json parser|api key|401/i,
    );
  });

  it("reports config preflight without exposing secrets", () => {
    const result = getAiProviderConfigPreflight();
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("degraded");
    expect(JSON.stringify(result)).not.toMatch(/sk-ant-/);
  });
});
