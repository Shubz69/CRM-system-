import {
  ImageProviderNotConfiguredError,
  type ImageProvider,
  type ImageResult,
  type ImageGenerateOptions,
} from "@/adapters/images/types";
import { getEnv } from "@/lib/env";

function parseSize(size?: string): { width: number; height: number; apiSize: string } {
  const raw = size || "1024x1024";
  const [w, h] = raw.split("x").map((n) => Number(n));
  return {
    width: w || 1024,
    height: h || 1024,
    apiSize: raw === "1024x1536" || raw === "1536x1024" ? raw : "1024x1024",
  };
}

/**
 * OpenAI image generation (gpt-image-1). Never used for Claude/Anthropic routing.
 */
export class OpenAiImageProvider implements ImageProvider {
  readonly name = "openai";

  async generate(options: ImageGenerateOptions): Promise<ImageResult> {
    const apiKey = getEnv().OPENAI_API_KEY;
    if (!apiKey) {
      throw new ImageProviderNotConfiguredError(
        "OPENAI_API_KEY is not configured for image generation",
      );
    }
    const model = getEnv().OPENAI_IMAGE_MODEL || "gpt-image-1";
    const { width, height, apiSize } = parseSize(options.size);

    const body: Record<string, unknown> = {
      model,
      prompt: options.prompt,
      size: apiSize,
      n: 1,
    };

    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI image generation failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const first = json.data?.[0];
    let bytes: Buffer;
    if (first?.b64_json) {
      bytes = Buffer.from(first.b64_json, "base64");
    } else if (first?.url) {
      const imgRes = await fetch(first.url);
      if (!imgRes.ok) throw new Error("Failed to download OpenAI image URL");
      bytes = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error("OpenAI image generation returned no image data");
    }

    return {
      bytes,
      mimeType: "image/png",
      width,
      height,
      provider: this.name,
      model,
      costCents: Number(getEnv().OPENAI_IMAGE_COST_CENTS || 8),
      rawMetadata: { size: apiSize },
    };
  }
}
