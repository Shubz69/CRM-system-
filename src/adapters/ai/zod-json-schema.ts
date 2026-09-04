import type { z } from "zod";

type JsonSchema = Record<string, unknown>;

/**
 * Minimal Zod → JSON Schema for Anthropic structured outputs.
 * Only covers shapes we use in research/analyst extraction (object/array/string/number/enum/optional).
 * Always emits additionalProperties:false on objects (Anthropic requirement).
 */
export function zodToAnthropicJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema, true);
}

function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  optional: boolean;
  nullable: boolean;
} {
  let current: z.ZodTypeAny = schema;
  let optional = false;
  let nullable = false;

  for (let i = 0; i < 12; i++) {
    const typeName = current._def?.typeName as string | undefined;
    if (typeName === "ZodOptional") {
      optional = true;
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (typeName === "ZodNullable") {
      nullable = true;
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (typeName === "ZodDefault") {
      optional = true;
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (typeName === "ZodEffects") {
      current = current._def.schema as z.ZodTypeAny;
      continue;
    }
    if (typeName === "ZodPipeline") {
      // Prefer the input side for generation; Zod still validates after parse.
      current = (current._def.in || current._def.out) as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { inner: current, optional, nullable };
}

function convert(schema: z.ZodTypeAny, requireObjectRoot: boolean): JsonSchema {
  const { inner, nullable } = unwrap(schema);
  const typeName = inner._def?.typeName as string | undefined;

  let base: JsonSchema;
  switch (typeName) {
    case "ZodObject": {
      const shape = inner._def.shape() as Record<string, z.ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const unwrapped = unwrap(value);
        properties[key] = convert(value, false);
        if (!unwrapped.optional) required.push(key);
      }
      base = {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
      break;
    }
    case "ZodArray": {
      const element = inner._def.type as z.ZodTypeAny;
      base = {
        type: "array",
        items: convert(element, false),
      };
      // Anthropic structured outputs only allow minItems 0 or 1; omit other bounds.
      const min = inner._def.minLength?.value;
      if (min === 0 || min === 1) base.minItems = min;
      break;
    }
    case "ZodString":
      // Omit minLength/maxLength/format — Anthropic rejects many string constraints.
      base = { type: "string" };
      break;
    case "ZodNumber":
      // Omit minimum/maximum — validated client-side by Zod after parse.
      base = { type: "number" };
      break;
    case "ZodBoolean":
      base = { type: "boolean" };
      break;
    case "ZodEnum": {
      const values = inner._def.values as string[];
      base = { type: "string", enum: values };
      break;
    }
    case "ZodLiteral": {
      const value = inner._def.value as string | number | boolean;
      base =
        typeof value === "string"
          ? { type: "string", const: value }
          : typeof value === "number"
            ? { type: "number", const: value }
            : { type: "boolean", const: value };
      break;
    }
    case "ZodRecord":
      base = { type: "object", additionalProperties: true };
      break;
    default:
      // Safe fallback — still an object if caller required one.
      base = requireObjectRoot
        ? { type: "object", properties: {}, additionalProperties: true }
        : {};
      break;
  }

  if (nullable) {
    return { anyOf: [base, { type: "null" }] };
  }
  return base;
}
