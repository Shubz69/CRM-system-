/**
 * Customer-safe video validation for YouTube / YouTube Short / TikTok content.
 * Does not invent stricter limits than providers document; no live publish.
 */
export type VideoValidationInput = {
  platform: "youtube" | "youtube_short" | "tiktok";
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  socialConnectionId?: string | null;
};

export type VideoValidationResult =
  | { ok: true }
  | { ok: false; error: string };

const MAX_TITLE = {
  youtube: 100,
  youtube_short: 100,
  tiktok: 2200, // TikTok caption/title budget (customer-facing caption)
} as const;

/** Soft guidance only — providers may accept wider ranges. */
export function validateSocialVideoDraft(input: VideoValidationInput): VideoValidationResult {
  const title = (input.title || "").trim();
  if (!title) {
    return { ok: false, error: "Add a title before submitting this video for approval." };
  }
  if (title.length > MAX_TITLE[input.platform]) {
    return {
      ok: false,
      error: `Title is too long for ${input.platform === "tiktok" ? "TikTok" : "YouTube"} (max ${MAX_TITLE[input.platform]} characters).`,
    };
  }
  if (!input.socialConnectionId) {
    return {
      ok: false,
      error: "Choose a connected channel or account before queueing publish.",
    };
  }
  if (input.mimeType && !input.mimeType.startsWith("video/")) {
    return {
      ok: false,
      error:
        input.platform === "tiktok"
          ? "TikTok Direct Post accepts video only."
          : "This publish path expects a video file.",
    };
  }
  if (typeof input.sizeBytes === "number" && input.sizeBytes <= 0) {
    return { ok: false, error: "Video file is missing or empty." };
  }
  // YouTube Shorts are typically vertical and under ~60s — warn as soft guidance only when known.
  if (
    input.platform === "youtube_short" &&
    typeof input.durationSeconds === "number" &&
    input.durationSeconds > 180
  ) {
    return {
      ok: false,
      error: "YouTube Short drafts should be short-form video (typically under 3 minutes).",
    };
  }
  if (
    input.platform === "youtube_short" &&
    typeof input.width === "number" &&
    typeof input.height === "number" &&
    input.width > 0 &&
    input.height > 0 &&
    input.width > input.height
  ) {
    return {
      ok: false,
      error: "YouTube Short drafts should use a vertical (portrait) video.",
    };
  }
  return { ok: true };
}
