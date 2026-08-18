import { SocialPlatform } from "@prisma/client";
import type { SocialProviderAdapter } from "./types";
import { instagramSocialAdapter } from "./instagram";
import { linkedInSocialAdapter } from "./linkedin";
import { tiktokSocialAdapter } from "./tiktok";

const ADAPTERS: Record<SocialPlatform, SocialProviderAdapter> = {
  [SocialPlatform.INSTAGRAM]: instagramSocialAdapter,
  [SocialPlatform.LINKEDIN]: linkedInSocialAdapter,
  [SocialPlatform.TIKTOK]: tiktokSocialAdapter,
};

export function getSocialProviderAdapter(platform: SocialPlatform): SocialProviderAdapter {
  return ADAPTERS[platform];
}

export function listSocialProviderAdapters(): SocialProviderAdapter[] {
  return Object.values(ADAPTERS);
}

export * from "./types";
