import type { AiCompletionRequest, AiProvider } from "@/adapters/ai/types";
import { getEnv } from "@/lib/env";
import { resolveModelForOptionalProvider } from "@/lib/ai-models";

/**
 * Google Gemini — optional secondary AI provider. Generous free tier on
 * Flash / Flash-Lite via Google AI Studio. Uses the native generateContent
 * REST API (not OpenAI-compatible), so request/response shapes differ from
 * the other optional adapters. Never required, never a silent default.
 *
 * Shares GEMINI_API_KEY with the image-generation adapter (same Google AI
 * Studio key) — chat model IDs are configured separately via
 * GEMINI_CHAT_*_MODEL so the two features never fight over one model env var.
 */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini";

  async complete(request: AiCompletionRequest): Promise<string> {
    const apiKey = getEnv().GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

    const model = request.model || resolveModelForOptionalProvider("gemini", "balanced");
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            temperature: request.temperature ?? 0.2,
            ...(request.jsonMode === false ? {} : { responseMimeType: "application/json" }),
          },
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      // Never log the API key (it is a query param on this endpoint).
      throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
    if (!text) throw new Error("Gemini returned an empty completion");
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
