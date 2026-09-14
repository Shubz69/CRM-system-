import { getEnv } from "@/lib/env";
import {
  VideoProviderNotConfiguredError,
  type VideoProvider,
} from "@/adapters/video/types";

export type { VideoGenerateOptions, VideoProvider, VideoResult } from "@/adapters/video/types";
export { VideoProviderNotConfiguredError } from "@/adapters/video/types";

const NOT_CONFIGURED_MESSAGE =
  "Example AI videos are not configured. Set VIDEO_PROVIDER and the matching API key to generate them. Ask still returns the four text answers and video briefs.";

/**
 * Resolve a video generation provider from env.
 * No video adapter is wired in this codebase (image generation is separate).
 * Unknown/unset providers fail closed — never invent a clip or URL.
 */
export function getVideoProvider(override?: string): VideoProvider {
  const env = getEnv();
  const configured = (override || env.VIDEO_PROVIDER || "none").toLowerCase();

  if (configured === "none" || configured === "") {
    throw new VideoProviderNotConfiguredError(NOT_CONFIGURED_MESSAGE);
  }

  if (configured === "openai" || configured === "sora") {
    throw new VideoProviderNotConfiguredError(
      "VIDEO_PROVIDER=openai is listed but no OpenAI video adapter is wired. AUTH_REQUIRED — video briefs are still available.",
    );
  }

  if (configured === "gemini" || configured === "google" || configured === "veo") {
    throw new VideoProviderNotConfiguredError(
      "VIDEO_PROVIDER=gemini is listed but no Gemini/Veo video adapter is wired. AUTH_REQUIRED — video briefs are still available.",
    );
  }

  throw new VideoProviderNotConfiguredError(
    `Unknown VIDEO_PROVIDER="${configured}". No video generation adapter is configured (AUTH_REQUIRED).`,
  );
}

export function isVideoProviderConfigured(): boolean {
  try {
    getVideoProvider();
    return true;
  } catch (error) {
    if (error instanceof VideoProviderNotConfiguredError) return false;
    throw error;
  }
}
