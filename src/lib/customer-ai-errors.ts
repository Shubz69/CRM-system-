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

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "SPEND_CAP_EXCEEDED"
  ) {
    const withMsg = error as { toCustomerMessage?: () => string };
    if (typeof withMsg.toCustomerMessage === "function") {
      return withMsg.toCustomerMessage();
    }
  }
  if (/spend cap exceeded|usage limit for this period/i.test(raw)) {
    return "This workspace has reached its Agent Desk intelligence usage limit for this period. CRM data is preserved — try again next period or contact your administrator.";
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
