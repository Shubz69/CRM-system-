import type { AiAnalysis } from "@/schemas/ai";

export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AiCompletionRequest = {
  model?: string;
  messages: AiMessage[];
  temperature?: number;
  jsonMode?: boolean;
};

export type AiProvider = {
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<string>;
  analyseConversation(input: {
    model?: string;
    systemPrompt: string;
    conversationTranscript: string;
    knowledgeContext: string;
    leadMessage: string;
  }): Promise<unknown>;
};

export type SafeAnalysisResult =
  | { ok: true; analysis: AiAnalysis; repaired: boolean }
  | { ok: false; reason: string; raw?: string };
