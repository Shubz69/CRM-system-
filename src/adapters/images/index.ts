import { GeminiImageProvider } from "@/adapters/images/gemini";
import { OpenAiImageProvider } from "@/adapters/images/openai";
import {
  ImageProviderNotConfiguredError,
  type ImageProvider,
} from "@/adapters/images/types";
import { getEnv } from "@/lib/env";

export type {
  ImageGenerateOptions,
  ImageProvider,
  ImageResult,
  ImageSize,
} from "@/adapters/images/types";
export {
  ImageProviderNotConfiguredError,
  ImageSafetyError,
} from "@/adapters/images/types";
export {
  imageBriefSchema,
  buildGenerationPromptFromBrief,
  assertImageBriefSafe,
  SAFETY_COPYRIGHT_MESSAGE,
  SAFETY_REAL_PERSON_MESSAGE,
  type ImageBrief,
} from "@/adapters/images/brief";

/**
 * Resolve image generation provider from config.
 * Claude/Anthropic is never used for generation.
 */
export function getImageProvider(override?: string): ImageProvider {
  const env = getEnv();
  const configured = (override || env.IMAGE_PROVIDER || "none").toLowerCase();

  if (configured === "none" || configured === "") {
    throw new ImageProviderNotConfiguredError(
      "Image generation is not configured. Set IMAGE_PROVIDER=openai|gemini and the matching API key.",
    );
  }

  if (configured === "anthropic" || configured === "claude") {
    throw new ImageProviderNotConfiguredError(
      "Claude does not generate images. Set IMAGE_PROVIDER=openai or IMAGE_PROVIDER=gemini.",
    );
  }

  if (configured === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new ImageProviderNotConfiguredError(
        "IMAGE_PROVIDER=openai requires OPENAI_API_KEY",
      );
    }
    return new OpenAiImageProvider();
  }

  if (configured === "gemini" || configured === "google") {
    if (!env.GEMINI_API_KEY) {
      throw new ImageProviderNotConfiguredError(
        "IMAGE_PROVIDER=gemini requires GEMINI_API_KEY",
      );
    }
    return new GeminiImageProvider();
  }

  throw new ImageProviderNotConfiguredError(
    `Unknown IMAGE_PROVIDER="${configured}". Supported: openai, gemini`,
  );
}

export function isImageProviderConfigured(): boolean {
  try {
    getImageProvider();
    return true;
  } catch (error) {
    if (error instanceof ImageProviderNotConfiguredError) return false;
    throw error;
  }
}

export function estimateImageGenerationCostCents(): number {
  const env = getEnv();
  const provider = (env.IMAGE_PROVIDER || "none").toLowerCase();
  if (provider === "openai") return Number(env.OPENAI_IMAGE_COST_CENTS || 8);
  if (provider === "gemini" || provider === "google") {
    return Number(env.GEMINI_IMAGE_COST_CENTS || 6);
  }
  return Number(env.OPENAI_IMAGE_COST_CENTS || 8);
}
