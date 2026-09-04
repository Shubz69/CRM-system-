import type { AiCompletionRequest, AiProvider } from "@/adapters/ai/types";
import {
  getAiProviderDefaults,
  isDeterministicAnthropicModelError,
  resolveModelForTier,
  resolveOperationalAnthropicModel,
} from "@/lib/ai-models";
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
    const model = resolveOperationalAnthropicModel(
      request.model || resolveModelForTier("default"),
      "default",
    );
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
        const maxTokens = Math.max(256, request.maxTokens ?? defaults.maxTokens);
        const body: Record<string, unknown> = {
          model,
          max_tokens: maxTokens,
          temperature: request.temperature ?? defaults.temperature,
          system: system || undefined,
          messages,
        };

        // Native structured outputs when a JSON Schema is provided.
        if (request.jsonSchema && typeof request.jsonSchema === "object") {
          body.output_config = {
            format: {
              type: "json_schema",
              schema: request.jsonSchema,
            },
          };
        }

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // If structured output is rejected for this model, retry once without it.
        if (
          !response.ok &&
          request.jsonSchema &&
          (response.status === 400 || response.status === 422)
        ) {
          const errBody = await response.text();
            if (/output_config|json_schema|structured|unsupported|invalid/i.test(errBody)) {
              logger.warn("Anthropic structured output unsupported — falling back to free JSON", {
                model,
                status: response.status,
                detail: errBody.slice(0, 180).replace(/sk-ant-[^\s"]+/g, "[redacted]"),
              });
            const fallbackBody = { ...body };
            delete fallbackBody.output_config;
            const retry = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(fallbackBody),
              signal: controller.signal,
            });
            if (!retry.ok) {
              const retryBody = await retry.text();
              throw new Error(
                `Anthropic request failed (${retry.status}): ${retryBody.slice(0, 300)}`,
              );
            }
            return this.readTextCompletion(await retry.json());
          }
          throw new Error(
            `Anthropic request failed (${response.status}): ${errBody.slice(0, 300)}`,
          );
        }

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(
            `Anthropic request failed (${response.status}): ${errBody.slice(0, 300)}`,
          );
        }

        return this.readTextCompletion(await response.json());
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Anthropic error");
        if (isDeterministicAnthropicModelError(lastError.message)) {
          logger.error("Anthropic deterministic model error — no retry", {
            model,
            message: lastError.message.slice(0, 200),
          });
          throw lastError;
        }
        if (attempt < retries) {
          logger.warn("Anthropic request retry", {
            attempt: attempt + 1,
            message: lastError.message,
          });
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new Error("Anthropic request failed");
  }

  private readTextCompletion(json: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }): string {
    this.lastUsage = {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
    const text = json.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("Anthropic returned an empty completion");
    return text;
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
