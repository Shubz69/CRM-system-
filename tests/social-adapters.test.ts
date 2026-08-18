import { afterEach, describe, expect, it, vi } from "vitest";
import { SocialPlatform } from "@prisma/client";

describe("social provider adapters — fail closed when unconfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("Instagram/LinkedIn/TikTok report not configured and throw on getAuthorizeUrl when env vars are unset", async () => {
    for (const key of [
      "INSTAGRAM_APP_ID",
      "INSTAGRAM_APP_SECRET",
      "INSTAGRAM_REDIRECT_URI",
      "LINKEDIN_CLIENT_ID",
      "LINKEDIN_CLIENT_SECRET",
      "LINKEDIN_REDIRECT_URI",
      "TIKTOK_CLIENT_KEY",
      "TIKTOK_CLIENT_SECRET",
      "TIKTOK_REDIRECT_URI",
    ]) {
      vi.stubEnv(key, "");
      delete process.env[key];
    }
    vi.resetModules();

    const { getSocialProviderAdapter, SocialNotConfiguredError } = await import("@/adapters/social");

    for (const platform of [SocialPlatform.INSTAGRAM, SocialPlatform.LINKEDIN, SocialPlatform.TIKTOK]) {
      const adapter = getSocialProviderAdapter(platform);
      expect(adapter.isConfigured()).toBe(false);
      expect(() => adapter.getAuthorizeUrl("state")).toThrow(SocialNotConfiguredError);
      await expect(adapter.exchangeCode("code")).rejects.toBeInstanceOf(SocialNotConfiguredError);
    }
  });

  it("reports capabilities honestly — no third-party DM API for LinkedIn/TikTok", async () => {
    const { getSocialProviderAdapter } = await import("@/adapters/social");
    expect(getSocialProviderAdapter(SocialPlatform.LINKEDIN).capabilities.message).toBe(false);
    expect(getSocialProviderAdapter(SocialPlatform.TIKTOK).capabilities.message).toBe(false);
    // Instagram DMs exist today, but via the separate ManyChat channel, not this adapter.
    expect(getSocialProviderAdapter(SocialPlatform.INSTAGRAM).capabilities.message).toBe(false);
  });

  it("Instagram becomes configured once its three env vars are set", async () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "app123");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "secret123");
    vi.stubEnv("INSTAGRAM_REDIRECT_URI", "https://example.com/api/social/instagram/callback");
    vi.resetModules();

    const { getSocialProviderAdapter } = await import("@/adapters/social");
    const adapter = getSocialProviderAdapter(SocialPlatform.INSTAGRAM);
    expect(adapter.isConfigured()).toBe(true);
    expect(adapter.getAuthorizeUrl("state123")).toContain("state=state123");
  });
});
