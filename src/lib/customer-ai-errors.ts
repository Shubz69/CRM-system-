/**
 * Customer-facing AI error sanitization — never leak vendor/provider names.
 */

const PROVIDER_LEAK =
  /\b(anthropic|claude|openai|gpt-4|gpt-3|groq|mistral|deepseek|gemini|ai provider)\b/i;

export const CUSTOMER_AI_UNAVAILABLE =
  "Agent Desk intelligence is temporarily unavailable.";

export function isProviderLeakingMessage(message: string): boolean {
  return PROVIDER_LEAK.test(message);
}

/** Map internal AI failures to a safe customer message. */
export function toCustomerAiError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : CUSTOMER_AI_UNAVAILABLE;

  if (
    isProviderLeakingMessage(raw) ||
    /api key|not configured|rate.?limit|429|401|403/i.test(raw)
  ) {
    return CUSTOMER_AI_UNAVAILABLE;
  }

  // Generic operational messages are OK if they don't name vendors
  if (raw.length > 200) return CUSTOMER_AI_UNAVAILABLE;
  return raw || CUSTOMER_AI_UNAVAILABLE;
}

/** Strip provider identity fields from a JSON-like health payload for customers. */
export function customerSafeAiHealth(ready: boolean) {
  return {
    label: "Agent Desk intelligence",
    ready,
    status: ready ? "AVAILABLE" : "UNAVAILABLE",
  };
}
