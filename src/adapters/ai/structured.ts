import type { z } from "zod";
import type { AiMessage, AiProvider } from "@/adapters/ai/types";
import { getAiProvider } from "@/adapters/ai";
import {
  resolveModelForTier,
  type FormalAiTier,
} from "@/lib/ai-models";
import { logger } from "@/lib/logger";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";

export type SafeStructuredResult<T> =
  | { ok: true; data: T; repaired: boolean; raw: unknown }
  | { ok: false; reason: string; raw?: unknown };

export class StructuredCompletionError extends Error {
  readonly code = "STRUCTURED_COMPLETION_FAILED";
  constructor(
    message: string,
    readonly reason: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = "StructuredCompletionError";
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() || trimmed;
  return JSON.parse(candidate) as unknown;
}

/**
 * Shared validate → one repair → flag loop used by completeStructured and
 * analyseWithValidation.
 */
export async function runWithZodRepair<T>(input: {
  schema: z.ZodType<T>;
  firstValue: unknown;
  repair: () => Promise<unknown>;
}): Promise<SafeStructuredResult<T>> {
  const first = input.schema.safeParse(input.firstValue);
  if (first.success) {
    return { ok: true, data: first.data, repaired: false, raw: input.firstValue };
  }

  logger.warn("Structured AI output failed Zod validation; attempting one repair", {
    issues: first.error.issues.map((i) => i.message).slice(0, 5),
  });

  let repairedRaw: unknown;
  try {
    repairedRaw = await input.repair();
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Repair attempt threw",
      raw: input.firstValue,
    };
  }

  const second = input.schema.safeParse(repairedRaw);
  if (second.success) {
    return { ok: true, data: second.data, repaired: true, raw: repairedRaw };
  }

  return {
    ok: false,
    reason: "AI output failed Zod validation after repair attempt",
    raw: repairedRaw,
  };
}

export type CompleteStructuredOptions = {
  organisationId: string;
  schema: z.ZodType<unknown>;
  /** System + user prompt, or full message list. */
  system?: string;
  prompt: string;
  messages?: AiMessage[];
  tier?: FormalAiTier;
  model?: string;
  temperature?: number;
  provider?: AiProvider;
  /** Extra repair instructions appended on the retry. */
  repairHint?: string;
  /** Skip spend gate (tests only). */
  skipSpendGate?: boolean;
};

/**
 * Generic structured completion: validate → one repair → flag/throw.
 * Always org-scoped via the pre-dispatch spend gate.
 */
export async function completeStructuredSafe<T>(
  schema: z.ZodType<T>,
  options: Omit<CompleteStructuredOptions, "schema"> & { schema?: z.ZodType<T> },
): Promise<SafeStructuredResult<T>> {
  if (!options.skipSpendGate) {
    await assertWithinSpendCap(options.organisationId);
  }

  const provider = options.provider || getAiProvider();
  const tier = options.tier || "balanced";
  const model = options.model || resolveModelForTier(tier);

  const baseMessages: AiMessage[] = options.messages?.length
    ? options.messages
    : [
        ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
        { role: "user", content: options.prompt },
      ];

  const jsonInstruction =
    "Respond with valid JSON only that matches the required schema. No markdown fences.";

  const firstMessages: AiMessage[] = [
    ...baseMessages.slice(0, -1),
    {
      role: "system",
      content: `${options.system || ""}\n${jsonInstruction}`.trim(),
    },
    ...baseMessages.filter((m) => m.role === "user" || m.role === "assistant").slice(-1),
  ];

  // Prefer: system + user from options
  const messages: AiMessage[] = options.messages?.length
    ? [
        { role: "system", content: `${options.system || ""}\n${jsonInstruction}`.trim() },
        ...options.messages.filter((m) => m.role !== "system"),
      ]
    : [
        ...(options.system
          ? [{ role: "system" as const, content: `${options.system}\n${jsonInstruction}` }]
          : [{ role: "system" as const, content: jsonInstruction }]),
        { role: "user", content: options.prompt },
      ];

  void firstMessages;

  let firstRawText: string;
  try {
    firstRawText = await provider.complete({
      model,
      messages,
      temperature: options.temperature,
      jsonMode: true,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "AI completion failed",
    };
  }

  let firstValue: unknown;
  try {
    firstValue = tryParseJson(firstRawText);
  } catch {
    firstValue = firstRawText;
  }

  return runWithZodRepair({
    schema,
    firstValue,
    repair: async () => {
      const repairMessages: AiMessage[] = [
        {
          role: "system",
          content: `${options.system || ""}\n${jsonInstruction}\nYour previous JSON was invalid. Repair it to match the schema exactly.${
            options.repairHint ? `\n${options.repairHint}` : ""
          }`,
        },
        { role: "user", content: options.prompt },
        { role: "assistant", content: firstRawText.slice(0, 8000) },
        {
          role: "user",
          content: "Return only the corrected JSON object.",
        },
      ];
      const repairedText = await provider.complete({
        model,
        messages: repairMessages,
        temperature: options.temperature ?? 0,
        jsonMode: true,
      });
      try {
        return tryParseJson(repairedText);
      } catch {
        return repairedText;
      }
    },
  });
}

/** Throws StructuredCompletionError if validation fails after one repair. */
export async function completeStructured<T>(
  schema: z.ZodType<T>,
  options: Omit<CompleteStructuredOptions, "schema">,
): Promise<T> {
  const result = await completeStructuredSafe(schema, { ...options, schema });
  if (!result.ok) {
    throw new StructuredCompletionError(
      result.reason,
      result.reason,
      result.raw,
    );
  }
  return result.data;
}
