import { SocialPlatform } from "@prisma/client";

const SLUG_TO_PLATFORM: Record<string, SocialPlatform> = {
  instagram: SocialPlatform.INSTAGRAM,
  linkedin: SocialPlatform.LINKEDIN,
  tiktok: SocialPlatform.TIKTOK,
};

/** URL segments (`/api/social/[platform]/...`) are lowercase slugs, never the raw enum. */
export function parseSocialPlatformSlug(slug: string): SocialPlatform | null {
  return SLUG_TO_PLATFORM[slug.toLowerCase()] ?? null;
}

export function socialPlatformSlug(platform: SocialPlatform): string {
  return platform.toLowerCase();
}
