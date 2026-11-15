/**
 * Validation errors read as sentences with the page's own field names — not zod's wording
 * ("Number must be less than or equal to 100") or camelCase paths ("restrictedTopics.0").
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readableZodError } from "@/lib/readable-zod";

const labels = {
  confidenceThreshold: "Confidence threshold",
  restrictedTopics: "Restricted topics",
  weight: "Weight",
  name: "Name",
  key: "Key",
  email: "Email",
  tone: "Tone",
};

function firstError(schema: z.ZodTypeAny, value: unknown): string {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error("expected a validation error");
  return readableZodError(parsed.error, labels);
}

describe("readableZodError", () => {
  it("numbers out of range name the field and the limit", () => {
    const schema = z.object({ confidenceThreshold: z.number().min(0).max(1) });
    expect(firstError(schema, { confidenceThreshold: 2 })).toBe("Confidence threshold must be at most 1.");
    expect(firstError(schema, { confidenceThreshold: -1 })).toBe("Confidence threshold must be at least 0.");
    expect(firstError(z.object({ weight: z.number().int().max(100) }), { weight: 101 })).toBe(
      "Weight must be at most 100.",
    );
  });

  it("list items are numbered for people, not indexed from zero", () => {
    const schema = z.object({ restrictedTopics: z.array(z.string()) });
    expect(firstError(schema, { restrictedTopics: ["ok", 5] })).toBe("Restricted topics (item 2) must be text.");
  });

  it("missing, empty and too-long text", () => {
    const schema = z.object({ name: z.string().min(1).max(10) });
    expect(firstError(schema, {})).toBe("Name is required.");
    expect(firstError(schema, { name: "" })).toBe("Name can't be empty.");
    expect(firstError(schema, { name: "x".repeat(11) })).toBe("Name must be 10 characters or fewer.");
  });

  it("choices and formats", () => {
    expect(firstError(z.object({ tone: z.enum(["warm", "formal"]) }), { tone: "loud" })).toBe(
      "Tone must be one of: warm, formal.",
    );
    expect(firstError(z.object({ email: z.string().email() }), { email: "nope" })).toBe(
      "Email must be a valid email address.",
    );
  });

  it("messages written in the schema are kept as they are", () => {
    const schema = z.object({ key: z.string().min(1, "Key is required") });
    expect(firstError(schema, { key: "" })).toBe("Key is required");
    const refined = z.object({ key: z.string().refine(() => false, { message: "Pick another key." }) });
    expect(firstError(refined, { key: "x" })).toBe("Pick another key.");
  });

  it("unknown fields fall back to a neutral label", () => {
    expect(firstError(z.object({ other: z.number() }), { other: "x" })).toBe("A field must be a number.");
  });
});
