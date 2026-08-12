import { z } from "zod";
import type { Agent } from "@/agents/types";

export const echoInputSchema = z.object({
  text: z.string().min(1).max(20_000),
});

export const echoOutputSchema = z.object({
  echo: z.string(),
});

export type EchoInput = z.infer<typeof echoInputSchema>;
export type EchoOutput = z.infer<typeof echoOutputSchema>;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Echo — proves the framework without calling a model.
 * Label must stay plain English (no agent/class names).
 */
export const echoAgent: Agent<EchoInput, EchoOutput> = {
  name: "echo",
  description: "Repeats the user's text back so they can confirm it was received.",
  inputSchema: echoInputSchema,
  outputSchema: echoOutputSchema,
  tier: "cheap",
  estimateCostCents: () => 0,
  userFacingLabel: (input) => {
    const words = wordCount(input.text || "");
    if (words <= 0) return "Repeating your message back";
    if (words === 1) return "Repeating your 1-word message back";
    return `Repeating your ${words}-word message back`;
  },
  async execute(input) {
    const parsed = echoInputSchema.parse(input);
    return {
      output: { echo: parsed.text },
      costCents: 0,
    };
  },
};
