import type { z } from "zod";
import type { AiMessage, AiProvider } from "@/adapters/ai/types";
import { getAiProvider } from "@/adapters/ai";
import {
  resolveModelForTier,
  type FormalAiTier,
} from "@/lib/ai-models";
import { logger } from "@/lib/logger";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { zodToAnthropicJsonSchema } from "@/adapters/ai/zod-json-schema";

export type SafeStructuredResult<T> =
  | { ok: true; data: T; repaired: boolean; raw: unknown }
  | { ok: false; reason: string; raw?: unknown; failureClass?: StructuredFailureClass };

export type StructuredFailureClass =
  | "PARSE_FAILED"
  | "SCHEMA_FAILED"
  | "PROVIDER_FAILED"
  | "EMPTY_CLAIMS"
  | "REPAIR_FAILED";

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

/**
 * Parse model text into a JSON value.
 * Unwraps markdown fences and one level of double-encoded JSON strings.
 */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() || trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    const objStart = candidate.indexOf("{");
    const objEnd = candidate.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      parsed = JSON.parse(candidate.slice(objStart, objEnd + 1)) as unknown;
    } else {
      const arrStart = candidate.indexOf("[");
      const arrEnd = candidate.lastIndexOf("]");
      if (arrStart >= 0 && arrEnd > arrStart) {
        parsed = JSON.parse(candidate.slice(arrStart, arrEnd + 1)) as unknown;
      } else {
        throw new Error("Response did not contain JSON");
      }
    }
  }
  return unwrapJsonStrings(parsed);
}

/** If the model returned a JSON string of JSON, unwrap a few times. */
export function unwrapJsonStrings(value: unknown, depth = 0): unknown {
  if (depth > 3) return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return unwrapJsonStrings(JSON.parse(trimmed) as unknown, depth + 1);
  } catch {
    return value;
  }
}

/**
 * Coerce raw completion text/value into the best structured candidate.
 * Never invents fields — only unwraps encoding/wrapping.
 */
export function coerceStructuredValue(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return tryParseJson(raw);
    } catch {
      return unwrapJsonStrings(raw);
    }
  }
  return unwrapJsonStrings(raw);
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
  const coercedFirst = coerceStructuredValue(input.firstValue);
  const first = input.schema.safeParse(coercedFirst);
  if (first.success) {
    return { ok: true, data: first.data, repaired: false, raw: coercedFirst };
  }

  logger.warn("Structured AI output failed Zod validation; attempting one repair", {
    issues: first.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).slice(0, 8),
    firstValueType: typeof coercedFirst,
  });

  let repairedRaw: unknown;
  try {
    repairedRaw = coerceStructuredValue(await input.repair());
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Repair attempt threw",
      raw: coercedFirst,
      failureClass: "REPAIR_FAILED",
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
    failureClass: "SCHEMA_FAILED",
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
  /** Override max tokens for large structured payloads. */
  maxTokens?: number;
  /** Optional explicit JSON Schema; otherwise derived from Zod. */
  jsonSchema?: Record<string, unknown>;
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

  const jsonInstruction =
    "Respond with valid JSON only that matches the required schema. No markdown fences. No prose before or after the JSON.";

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

  let jsonSchema: Record<string, unknown> | undefined = options.jsonSchema;
  if (!jsonSchema) {
    try {
      jsonSchema = zodToAnthropicJsonSchema(schema as unknown as z.ZodTypeAny);
    } catch {
      jsonSchema = undefined;
    }
  }

  const maxTokens = options.maxTokens ?? 8192;

  let firstRawText: string;
  try {
    firstRawText = await provider.complete({
      model,
      messages,
      temperature: options.temperature,
      jsonMode: true,
      jsonSchema,
      maxTokens,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "AI completion failed",
      failureClass: "PROVIDER_FAILED",
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
          content: `${options.system || ""}\n${jsonInstruction}\nYour previous JSON was invalid. Repair it to match the schema exactly. Do not invent evidence or URLs.${
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
        jsonSchema,
        maxTokens,
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
