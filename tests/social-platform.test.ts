import { describe, expect, it } from "vitest";
import { SocialPlatform } from "@prisma/client";
import { parseSocialPlatformSlug, socialPlatformSlug } from "@/lib/social-platform";

describe("social platform slug mapping", () => {
  it("parses known slugs case-insensitively", () => {
    expect(parseSocialPlatformSlug("instagram")).toBe(SocialPlatform.INSTAGRAM);
    expect(parseSocialPlatformSlug("LinkedIn")).toBe(SocialPlatform.LINKEDIN);
    expect(parseSocialPlatformSlug("TIKTOK")).toBe(SocialPlatform.TIKTOK);
  });

  it("returns null for unknown slugs — never guesses", () => {
    expect(parseSocialPlatformSlug("facebook")).toBeNull();
    expect(parseSocialPlatformSlug("")).toBeNull();
  });

  it("round-trips platform -> slug -> platform", () => {
    for (const platform of Object.values(SocialPlatform)) {
      expect(parseSocialPlatformSlug(socialPlatformSlug(platform))).toBe(platform);
    }
  });
});
