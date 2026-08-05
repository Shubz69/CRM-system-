import { describe, expect, it } from "vitest";
import { detectOptOut } from "@/services/opt-out";

describe("detectOptOut", () => {
  it("detects configured opt-out language case-insensitively", () => {
    expect(detectOptOut("Please STOP messaging me")).toBe(true);
    expect(detectOptOut("I would like to unsubscribe")).toBe(true);
  });

  it("does not flag ordinary messages", () => {
    expect(detectOptOut("Can you send the pricing details?")).toBe(false);
  });
});
