import type { AiCompletionRequest, AiProvider } from "@/adapters/ai/types";
import { getEnv } from "@/lib/env";
import { resolveModelForOptionalProvider } from "@/lib/ai-models";

/**
 * Groq — optional secondary AI provider. Free tier, OpenAI-compatible API,
 * very fast Llama/Qwen inference. Never required, never a silent default —
 * only reached via an explicit getAiProvider("groq") or AI_PROVIDER=groq.
 */
export class GroqProvider implements AiProvider {
  readonly name = "groq";

  async complete(request: AiCompletionRequest): Promise<string> {
    const apiKey = getEnv().GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not configured");

    const model = request.model || resolveModelForOptionalProvider("groq", "balanced");
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
      throw new Error(`Groq request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned an empty completion");
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
