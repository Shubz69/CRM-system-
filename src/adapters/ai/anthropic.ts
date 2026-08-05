import type { AiCompletionRequest, AiProvider } from "@/adapters/ai/types";
import { getEnv } from "@/lib/env";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";

  async complete(request: AiCompletionRequest): Promise<string> {
    const apiKey = getEnv().ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

    const model = request.model || "claude-3-5-haiku-latest";
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature: request.temperature ?? 0.2,
        system: system || undefined,
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
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
          content: `${input.systemPrompt}\n\nRespond with ONLY valid JSON.`,
        },
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
          ].join("\n"),
        },
      ],
    });

    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Anthropic response did not contain JSON");
    return JSON.parse(match[0]) as unknown;
  }
}
