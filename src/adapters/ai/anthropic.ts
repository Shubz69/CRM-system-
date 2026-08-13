import type { AiCompletionRequest, AiProvider } from "@/adapters/ai/types";
import { getAiProviderDefaults, resolveModelForTier } from "@/lib/ai-models";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { CLAUDE_DECISION_JSON_INSTRUCTIONS } from "@/schemas/ai";

export type AnthropicUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Anthropic Claude provider via Messages API (no SDK required).
 * Primary AI provider for Agent Desk.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  lastUsage: AnthropicUsage = {};

  async complete(request: AiCompletionRequest): Promise<string> {
    const apiKey = getEnv().ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

    const defaults = getAiProviderDefaults();
    const model = request.model || resolveModelForTier("default");
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const retries = Math.max(0, defaults.retries);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), defaults.timeoutMs);
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: defaults.maxTokens,
            temperature: request.temperature ?? defaults.temperature,
            system: system || undefined,
            messages,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          // Never log the API key
          throw new Error(`Anthropic request failed (${response.status}): ${body.slice(0, 300)}`);
        }

        const json = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        this.lastUsage = {
          inputTokens: json.usage?.input_tokens,
          outputTokens: json.usage?.output_tokens,
        };

        const text = json.content?.find((c) => c.type === "text")?.text;
        if (!text) throw new Error("Anthropic returned an empty completion");
        return text;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Anthropic error");
        if (attempt < retries) {
          logger.warn("Anthropic request retry", { attempt: attempt + 1, message: lastError.message });
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new Error("Anthropic request failed");
  }

  async analyseConversation(input: {
    model?: string;
    systemPrompt: string;
    conversationTranscript: string;
    knowledgeContext: string;
    leadMessage: string;
  }): Promise<unknown> {
    const content = await this.complete({
      model: input.model,
      messages: [
        {
          role: "system",
          content: `${input.systemPrompt}\n\n${CLAUDE_DECISION_JSON_INSTRUCTIONS}`,
        },
        {
          role: "user",
          content: [
            "Knowledge context (approved business facts only):",
            input.knowledgeContext || "(none)",
            "",
            "Conversation transcript:",
            input.conversationTranscript || "(none)",
            "",
            "Latest lead message:",
            input.leadMessage,
            "",
            "Respond with ONLY valid JSON for the structured decision schema.",
          ].join("\n"),
        },
      ],
    });

    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Anthropic response did not contain JSON");
    return JSON.parse(match[0]) as unknown;
  }
}
