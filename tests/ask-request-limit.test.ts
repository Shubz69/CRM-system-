import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ASK_REQUEST_MAX_CHARS } from "@/app/api/ask/route";

/** Mirror of createSchema.request — keeps the product rule under unit test. */
const requestSchema = z
  .string()
  .min(1)
  .max(ASK_REQUEST_MAX_CHARS);

describe("Ask request length", () => {
  it("accepts prompts larger than the old 20k cap (business-plan pastes)", () => {
    const text = "x".repeat(50_000);
    expect(requestSchema.safeParse(text).success).toBe(true);
  });

  it("accepts near the safety ceiling", () => {
    const text = "a".repeat(ASK_REQUEST_MAX_CHARS);
    expect(requestSchema.safeParse(text).success).toBe(true);
  });

  it("still rejects empty prompts", () => {
    expect(requestSchema.safeParse("").success).toBe(false);
  });

  it("only rejects absurd multi-megabyte bodies as a DoS guard", () => {
    const text = "b".repeat(ASK_REQUEST_MAX_CHARS + 1);
    expect(requestSchema.safeParse(text).success).toBe(false);
  });
});
