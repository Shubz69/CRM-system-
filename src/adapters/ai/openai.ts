import type { AiCompletionRequest, AiProvider } from "@/adapters/ai/types";
import { getEnv } from "@/lib/env";

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";

  async complete(request: AiCompletionRequest): Promise<string> {
    const apiKey = getEnv().OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

    const model = request.model || "gpt-4o-mini";
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
      throw new Error(`OpenAI request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty completion");
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
