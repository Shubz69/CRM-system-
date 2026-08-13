/**
 * Instagram / LinkedIn / TikTok — licensed Apify providers only.
 * No direct scraping. Without APIFY_TOKEN these throw SourceNotConfiguredError.
 */
import {
  createApifySourceAdapter,
  INSTAGRAM_APIFY_CONFIG,
  LINKEDIN_APIFY_CONFIG,
  TIKTOK_APIFY_CONFIG,
} from "@/adapters/sources/apify-platforms";

export const instagramSourceAdapter = createApifySourceAdapter(INSTAGRAM_APIFY_CONFIG);
export const linkedInSourceAdapter = createApifySourceAdapter(LINKEDIN_APIFY_CONFIG);
export const tiktokSourceAdapter = createApifySourceAdapter(TIKTOK_APIFY_CONFIG);
