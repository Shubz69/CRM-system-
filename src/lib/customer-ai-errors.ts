/**
 * Customer-facing AI error sanitization — never leak vendor/provider names.
 */

const PROVIDER_LEAK =
  /\b(anthropic|claude|openai|gpt-4|gpt-3|groq|mistral|deepseek|gemini|tavily|exa|apify|prisma|postgres|redis|zod|ai provider|model:\s*claude|sonnet-4)\b/i;

export const CUSTOMER_AI_UNAVAILABLE =
  "Agent Desk intelligence is temporarily unavailable.";

export const CUSTOMER_AI_VALIDATE_FAILED =
  "Agent Desk couldn't validate this information right now. Please try again.";

export function isProviderLeakingMessage(message: string): boolean {
  return (
    PROVIDER_LEAK.test(message) ||
    /\bapi key\b/i.test(message) ||
    /\bembedding(s)?\b/i.test(message) ||
    /not_found_error|model:\s*[\w.-]+/i.test(message)
  );
}

function customerSafeToolName(name: string): string {
  return name
    .replace(/\btavily\b/gi, "web")
    .replace(/\bexa\b/gi, "web")
    .replace(/\bapify\b/gi, "source")
    .replace(/\bopenai\b/gi, "ai")
    .replace(/\banthropic\b/gi, "ai");
}

/** Strip vendor identifiers from client Ask payloads (admin kernel included). */
export function sanitizeAskClientPayload<T>(value: T): T {
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === "string") {
      if (key === "url" || key === "sourceUrl" || key === "href") return node;
      if (key === "toolName" || key === "name") return customerSafeToolName(node);
      if (isProviderLeakingMessage(node)) {
        return node.replace(PROVIDER_LEAK, "service").replace(/\bapi key\b/gi, "credential");
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (node && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>).filter(
        ([k]) =>
          k !== "__proto__" &&
          k !== "constructor" &&
          k !== "prototype" &&
          k !== "registeredTools" &&
          k !== "rawMetadata",
      );
      return Object.fromEntries(entries.map(([k, v]) => [k, walk(v, k)]));
    }
    return node;
  };
  return walk(value) as T;
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
    /api key|not configured|rate.?limit|429|401|403|404/i.test(raw)
  ) {
    if (/validat/i.test(raw)) return CUSTOMER_AI_VALIDATE_FAILED;
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
