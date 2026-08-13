import {
  ImageProviderNotConfiguredError,
  type ImageProvider,
  type ImageResult,
  type ImageGenerateOptions,
} from "@/adapters/images/types";
import { getEnv } from "@/lib/env";

function parseSize(size?: string): { width: number; height: number } {
  const raw = size || "1024x1024";
  const [w, h] = raw.split("x").map((n) => Number(n));
  return { width: w || 1024, height: h || 1024 };
}

/**
 * Google Gemini / Imagen image generation.
 * Uses the Generative Language API. Never routes through Anthropic.
 */
export class GeminiImageProvider implements ImageProvider {
  readonly name = "gemini";

  async generate(options: ImageGenerateOptions): Promise<ImageResult> {
    const apiKey = getEnv().GEMINI_API_KEY;
    if (!apiKey) {
      throw new ImageProviderNotConfiguredError(
        "GEMINI_API_KEY is not configured for image generation",
      );
    }
    const model = getEnv().GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002";
    const { width, height } = parseSize(options.size);

    // Imagen predict endpoint via Generative Language API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: options.prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: width === height ? "1:1" : width > height ? "16:9" : "9:16",
        },
      }),
    });

    if (!res.ok) {
      // Fallback: gemini native image generation endpoint shape
      const fallbackModel =
        getEnv().GEMINI_IMAGE_MODEL_FALLBACK || "gemini-2.0-flash-preview-image-generation";
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(fallbackModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const fallback = await fetch(fallbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: options.prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      });
      if (!fallback.ok) {
        const text = await res.text();
        const text2 = await fallback.text();
        throw new Error(
          `Gemini image generation failed (${res.status}/${fallback.status}): ${(text || text2).slice(0, 400)}`,
        );
      }
      const fj = (await fallback.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
        }>;
      };
      const part = fj.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) {
        throw new Error("Gemini image generation returned no image data");
      }
      return {
        bytes: Buffer.from(part.inlineData.data, "base64"),
        mimeType: part.inlineData.mimeType || "image/png",
        width,
        height,
        provider: this.name,
        model: fallbackModel,
        costCents: Number(getEnv().GEMINI_IMAGE_COST_CENTS || 6),
      };
    }

    const json = (await res.json()) as {
      predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
    };
    const pred = json.predictions?.[0];
    if (!pred?.bytesBase64Encoded) {
      throw new Error("Gemini Imagen returned no image data");
    }

    return {
      bytes: Buffer.from(pred.bytesBase64Encoded, "base64"),
      mimeType: pred.mimeType || "image/png",
      width,
      height,
      provider: this.name,
      model,
      costCents: Number(getEnv().GEMINI_IMAGE_COST_CENTS || 6),
    };
  }
}
