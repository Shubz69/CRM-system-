/**
 * Desk research platform selection + human listen-channel labels.
 * Apify Instagram/LinkedIn/TikTok adapters stay wired; they run only when
 * the ask names those networks (or the caller passes platforms). Generic
 * desk research stays web-only so the 30s ceiling holds.
 */

import type { SourcePlatform } from "@/adapters/sources/types";

export const APIFY_LISTEN_PLATFORMS = [
  "instagram",
  "linkedin",
  "tiktok",
  "twitter",
  "threads",
] as const;

const TOPIC_HINTS: Array<{ re: RegExp; platform: SourcePlatform }> = [
  { re: /\b(instagram|insta|reels?)\b/i, platform: "instagram" },
  { re: /\blinkedin\b/i, platform: "linkedin" },
  { re: /\btiktoks?\b/i, platform: "tiktok" },
  { re: /\b(twitter|tweets?)\b/i, platform: "twitter" },
  { re: /\bthreads\b/i, platform: "threads" },
];

export function inferResearchListenPlatforms(
  topic: string,
  configured: SourcePlatform[],
): SourcePlatform[] {
  const configuredSet = new Set(configured);
  const mentioned = TOPIC_HINTS.filter((hint) => hint.re.test(topic))
    .map((hint) => hint.platform)
    .filter((platform) => configuredSet.has(platform));

  const selected: SourcePlatform[] = [];
  if (configuredSet.has("web")) selected.push("web");
  for (const platform of mentioned) {
    if (!selected.includes(platform)) selected.push(platform);
  }
  if (selected.length > 0) return selected;
  return configuredSet.has("web") ? (["web"] as SourcePlatform[]) : configured;
}

export function labelResearchListenChannel(
  platform: string | null | undefined,
): string | undefined {
  if (!platform) return undefined;
  const key = platform.trim().toLowerCase();
  const labels: Record<string, string> = {
    instagram: "Apify · Instagram",
    linkedin: "Apify · LinkedIn",
    tiktok: "Apify · TikTok",
    twitter: "Apify · X",
    threads: "Apify · Threads",
    web: "Web search",
    youtube: "YouTube",
    reddit: "Reddit",
  };
  return labels[key] || platform;
}

export function isApifyListenPlatform(platform: string | null | undefined): boolean {
  return APIFY_LISTEN_PLATFORMS.includes(
    (platform || "").toLowerCase() as (typeof APIFY_LISTEN_PLATFORMS)[number],
  );
}
