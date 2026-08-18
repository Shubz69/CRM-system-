/**
 * Instagram / LinkedIn / TikTok / Twitter(X) / Threads — licensed Apify
 * providers only. No direct scraping. Without APIFY_TOKEN these throw
 * SourceNotConfiguredError.
 *
 * Facebook is deliberately NOT included here: no Apify actor reliably
 * supports open keyword/hashtag search on Facebook (public search scraping
 * is far more locked down there than IG/TikTok/X/Threads) — every actor we
 * evaluated requires specific page/profile URLs as input instead of a search
 * term, which doesn't fit this adapter's search(query) contract. Building a
 * "monitor these specific pages" feature is possible later but is a
 * different feature from keyword listening, so it's out of scope here.
 */
import {
  createApifySourceAdapter,
  INSTAGRAM_APIFY_CONFIG,
  LINKEDIN_APIFY_CONFIG,
  THREADS_APIFY_CONFIG,
  TIKTOK_APIFY_CONFIG,
  TWITTER_APIFY_CONFIG,
} from "@/adapters/sources/apify-platforms";

export const instagramSourceAdapter = createApifySourceAdapter(INSTAGRAM_APIFY_CONFIG);
export const linkedInSourceAdapter = createApifySourceAdapter(LINKEDIN_APIFY_CONFIG);
export const tiktokSourceAdapter = createApifySourceAdapter(TIKTOK_APIFY_CONFIG);
export const twitterSourceAdapter = createApifySourceAdapter(TWITTER_APIFY_CONFIG);
export const threadsSourceAdapter = createApifySourceAdapter(THREADS_APIFY_CONFIG);
