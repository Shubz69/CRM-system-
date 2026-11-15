import type { z } from "zod";

/**
 * One plain-English sentence for the first problem in a zod error, using the caller's field
 * labels — never zod's own wording ("Number must be less than or equal to 100") or camelCase
 * paths ("restrictedTopics.0").
 *
 * Messages set explicitly in a schema (`.min(1, "Key is required")`, `.refine(…, { message })`)
 * are already sentences and are returned as they are.
 */
export function readableZodError(
  error: z.ZodError,
  labels: Record<string, string>,
  fallback = "Check the details and try again.",
): string {
  const issue = error.issues[0];
  if (!issue) return fallback;

  const field = String(issue.path[0] ?? "");
  const label = labels[field] ?? "A field";
  const item = issue.path.length > 1 && typeof issue.path[1] === "number" ? ` (item ${issue.path[1] + 1})` : "";
  const subject = `${label}${item}`;

  if (issue.code === "custom" || hasCustomMessage(issue)) return issue.message;

  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined" || issue.received === "null") return `${subject} is required.`;
      return `${subject} must be ${typeName(issue.expected)}.`;
    case "too_small":
      if (issue.type === "string") {
        return Number(issue.minimum) <= 1 ? `${subject} can't be empty.` : `${subject} must be at least ${String(issue.minimum)} characters.`;
      }
      if (issue.type === "array") return `${subject} needs at least ${String(issue.minimum)} item${Number(issue.minimum) === 1 ? "" : "s"}.`;
      return `${subject} must be ${issue.inclusive ? "at least" : "more than"} ${String(issue.minimum)}.`;
    case "too_big":
      if (issue.type === "string") return `${subject} must be ${String(issue.maximum)} characters or fewer.`;
      if (issue.type === "array") return `${subject} can have at most ${String(issue.maximum)} items.`;
      return `${subject} must be ${issue.inclusive ? "at most" : "less than"} ${String(issue.maximum)}.`;
    case "invalid_enum_value":
      return `${subject} must be one of: ${issue.options.map(String).join(", ")}.`;
    case "invalid_string":
      if (issue.validation === "email") return `${subject} must be a valid email address.`;
      if (issue.validation === "url") return `${subject} must be a full web address.`;
      return `${subject} is invalid.`;
    case "not_finite":
      return `${subject} must be a number.`;
    default:
      return `${subject} is invalid.`;
  }
}

/** zod's built-in messages start with these; anything else was written by us in the schema. */
const ZOD_DEFAULT_PREFIXES = [
  "Required",
  "Expected ",
  "Invalid",
  "Number must",
  "String must",
  "Array must",
  "Value must",
  "Unrecognized",
];

function hasCustomMessage(issue: z.ZodIssue): boolean {
  return !ZOD_DEFAULT_PREFIXES.some((prefix) => issue.message.startsWith(prefix));
}

function typeName(expected: string): string {
  if (expected === "string") return "text";
  if (expected === "number" || expected === "integer") return "a number";
  if (expected === "boolean") return "on or off";
  if (expected === "array") return "a list";
  if (expected === "object") return "a set of values";
  return `a ${expected}`;
}
