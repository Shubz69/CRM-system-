/** Allowed Content OS platform values (customer-facing). */
export const CONTENT_PLATFORMS = [
  "instagram",
  "linkedin",
  "youtube",
  "youtube_short",
  "tiktok",
] as const;

export type ContentPlatform = (typeof CONTENT_PLATFORMS)[number];

export function normalizeContentPlatform(raw: string | null | undefined): ContentPlatform | null {
  if (!raw) return null;
  const p = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (p === "instagram" || p === "ig") return "instagram";
  if (p === "linkedin" || p === "li") return "linkedin";
  if (p === "youtube" || p === "yt") return "youtube";
  if (p === "youtube_short" || p === "youtube_shorts" || p === "shorts" || p === "yt_short") {
    return "youtube_short";
  }
  if (p === "tiktok" || p === "tt") return "tiktok";
  return null;
}

/** Publish adapter network for a content platform intention. */
export function publishNetworkForContentPlatform(
  platform: string | null | undefined,
): "INSTAGRAM" | "LINKEDIN" | "YOUTUBE" | "TIKTOK" | null {
  const n = normalizeContentPlatform(platform);
  if (!n) return null;
  if (n === "instagram") return "INSTAGRAM";
  if (n === "linkedin") return "LINKEDIN";
  if (n === "youtube" || n === "youtube_short") return "YOUTUBE";
  if (n === "tiktok") return "TIKTOK";
  return null;
}
