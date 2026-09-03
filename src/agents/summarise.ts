import { z } from "zod";
import type { Agent } from "@/agents/types";
import { completeStructuredSafe } from "@/adapters/ai/structured";
import { resolveModelForTier } from "@/lib/ai-models";

export const summariseInputSchema = z.object({
  text: z.string().min(1).max(50_000),
  maxSentences: z.number().int().min(1).max(8).optional(),
});

export const summariseOutputSchema = z.object({
  summary: z.string().min(1),
});

export type SummariseInput = z.infer<typeof summariseInputSchema>;
export type SummariseOutput = z.infer<typeof summariseOutputSchema>;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Summarise — short plain-language summary via completeStructured + cheap tier.
 */
export const summariseAgent: Agent<SummariseInput, SummariseOutput> = {
  name: "summarise",
  description: "Shortens longer text into a brief plain-English summary.",
  inputSchema: summariseInputSchema,
  outputSchema: summariseOutputSchema,
  tier: "cheap",
  estimateCostCents: (input) => {
    const words = wordCount(input.text || "");
    // Rough: ~0.1¢ per 100 words, minimum 1¢ when AI will run.
    return Math.max(1, Math.ceil(words / 100));
  },
  userFacingLabel: (input) => {
    const words = wordCount(input.text || "");
    const sentences = input.maxSentences ?? 3;
    if (words <= 0) return "Writing a short summary of your text";
    return `Summarising ${words} words into about ${sentences} sentences`;
  },
  async execute(input, ctx) {
    const parsed = summariseInputSchema.parse(input);
    const maxSentences = parsed.maxSentences ?? 3;
    const model = resolveModelForTier("cheap");
    const result = await completeStructuredSafe(summariseOutputSchema, {
      organisationId: ctx.organisationId,
      tier: "cheap",
      model,
      system:
        "You write short, clear summaries for busy business owners. No jargon. No bullet lists unless the source is a list.",
      prompt: `Summarise the following text in at most ${maxSentences} sentences.\n\n---\n${parsed.text}\n---`,
      temperature: 0.2,
    });
    if (!result.ok) {
      // Deterministic degrade — never fail the whole Ask on schema/provider flakiness.
      const trimmed = parsed.text.trim().replace(/\s+/g, " ");
      const fallback =
        trimmed.length <= 400
          ? trimmed
          : `${trimmed.slice(0, 397).trimEnd()}…`;
      return {
        output: { summary: fallback },
        model,
        costCents: summariseAgent.estimateCostCents(parsed),
      };
    }
    return {
      output: result.data,
      model,
      costCents: summariseAgent.estimateCostCents(parsed),
    };
  },
};
