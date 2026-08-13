import {
  SourceNotConfiguredError,
  type SourceAdapter,
  type SourcePlatform,
} from "@/adapters/sources/types";

/**
 * Licensed-provider placeholders. Terms prohibit scraping; do not invent data.
 * Drop in Apify / Bright Data (etc.) behind the same SourceAdapter interface later.
 */
function stubAdapter(platform: SourcePlatform, displayName: string): SourceAdapter {
  return {
    platform,
    displayName,
    async search() {
      throw new SourceNotConfiguredError(
        platform,
        `${displayName} is not configured. Scraping is not supported — connect a licensed provider (e.g. Apify, Bright Data) before enabling this source.`,
      );
    },
  };
}

export const instagramSourceAdapter = stubAdapter("instagram", "Instagram");
export const linkedInSourceAdapter = stubAdapter("linkedin", "LinkedIn");
export const tiktokSourceAdapter = stubAdapter("tiktok", "TikTok");
