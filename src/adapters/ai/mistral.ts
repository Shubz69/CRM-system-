import type { AiCompletionRequest, AiProvider } from "@/adapters/ai/types";
import { getEnv } from "@/lib/env";
import { resolveModelForOptionalProvider } from "@/lib/ai-models";

/**
 * Mistral — optional secondary AI provider (La Plateforme). Has a free/
 * experiment usage tier with rate limits. OpenAI-compatible chat completions
 * endpoint. Never required, never a silent default.
 */
export class MistralProvider implements AiProvider {
  readonly name = "mistral";

  async complete(request: AiCompletionRequest): Promise<string> {
    const apiKey = getEnv().MISTRAL_API_KEY;
    if (!apiKey) throw new Error("MISTRAL_API_KEY is not configured");

    const model = request.model || resolveModelForOptionalProvider("mistral", "balanced");
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: request.temperature ?? 0.2,
        response_format: request.jsonMode === false ? undefined : { type: "json_object" },
        messages: request.messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mistral request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("Mistral returned an empty completion");
    return content;
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
      jsonMode: true,
      messages: [
        { role: "system", content: input.systemPrompt },
        {
          role: "user",
          content: [
            "Knowledge context:",
            input.knowledgeContext || "(none)",
            "",
            "Conversation transcript:",
            input.conversationTranscript || "(none)",
            "",
            "Latest lead message:",
            input.leadMessage,
            "",
            "Return ONLY valid JSON matching the required schema.",
          ].join("\n"),
        },
      ],
    });
    return JSON.parse(content) as unknown;
  }
}
