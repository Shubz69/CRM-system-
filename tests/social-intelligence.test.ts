import { describe, expect, it } from "vitest";
import { inferContentFormat, upsertSocialContentFromSource } from "@/services/social-intelligence";
import { isExcerptGrounded } from "@/services/research-evidence";

describe("inferContentFormat", () => {
  it("detects shorts and reels", () => {
    expect(
      inferContentFormat({
        platform: "youtube",
        url: "https://www.youtube.com/shorts/abc",
      }),
    ).toBe("short");
    expect(
      inferContentFormat({
        platform: "instagram",
        url: "https://www.instagram.com/reel/xyz/",
      }),
    ).toBe("reel");
    expect(
      inferContentFormat({
        platform: "web",
        url: "https://example.com/article",
      }),
    ).toBe("other");
  });
});

describe("excerpt grounding skip", () => {
  it("skips grounding when source body is empty (does not fail Ask)", () => {
    const r = isExcerptGrounded({
      claim: "Something happened on the feed",
      evidenceExcerpt: null,
      sourceContent: "",
    });
    expect(r.skipped).toBe(true);
    expect(r.grounded).toBe(true);
  });
});

describe("upsertSocialContentFromSource", () => {
  it("is exported for worker / research ingest paths", () => {
    expect(typeof upsertSocialContentFromSource).toBe("function");
  });
});
