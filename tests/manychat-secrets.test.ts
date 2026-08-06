import { describe, expect, it } from "vitest";
import { maskSecret } from "@/services/manychat-secrets";

describe("manychat secret masking", () => {
  it("never returns the full secret", () => {
    const secret = "mc_abcdefghijklmnopqrstuvwxyz012345";
    const masked = maskSecret(secret);
    expect(masked).not.toBe(secret);
    expect(masked.includes("…") || masked.includes("•")).toBe(true);
  });

  it("handles missing secrets", () => {
    expect(maskSecret(null)).toBe("not set");
    expect(maskSecret("")).toBe("not set");
  });
});
