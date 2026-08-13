import {
  imageBriefSchema,
  type ImageBrief,
  SAFETY_COPYRIGHT_MESSAGE,
  SAFETY_REAL_PERSON_MESSAGE,
} from "@/adapters/images/brief";
import { ImageSafetyError } from "@/adapters/images/types";
import { getAiProvider } from "@/adapters/ai";
import { runWithZodRepair } from "@/adapters/ai/structured";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { getEnv } from "@/lib/env";
import { resolveModelForTier } from "@/lib/ai-models";

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() || trimmed;
  return JSON.parse(candidate) as unknown;
}

/**
 * Vision analysis of a reference image → structured ImageBrief.
 * Uses Claude or GPT-4-class chat vision — never Anthropic for image *generation*.
 */
export async function analyseReferenceImage(input: {
  organisationId: string;
  userRequest: string;
  imageBytes: Buffer;
  mimeType: string;
}): Promise<{ brief: ImageBrief; model: string; costCents: number }> {
  await assertWithinSpendCap(input.organisationId, 2);

  const env = getEnv();
  const preferOpenAiVision = Boolean(env.OPENAI_API_KEY) && !env.ANTHROPIC_API_KEY;
  const model = preferOpenAiVision
    ? env.OPENAI_VISION_MODEL || "gpt-4o"
    : resolveModelForTier("balanced");

  const system = `You analyse a reference image so we can generate something *like* it — not a copy of copyrighted IP or a real person's likeness.
Return JSON matching the schema. Be specific about composition, colour palette, style, subject, mood, and text treatment.
Set safety.depictsRealPerson=true if the image shows a real identifiable person.
Set safety.depictsCopyrightedCharacterOrLogo=true for copyrighted characters, logos, or branded IP.
proposedPrompt must be an original generation prompt inspired by the reference and the user request — never "recreate Mickey Mouse" etc.`;

  const userText = `User request:\n${input.userRequest}\n\nAnalyse the attached reference image and return JSON only.`;

  let rawText: string;
  if (preferOpenAiVision) {
    rawText = await openAiVisionComplete({
      apiKey: env.OPENAI_API_KEY!,
      model,
      system,
      userText,
      imageBytes: input.imageBytes,
      mimeType: input.mimeType,
    });
  } else {
    rawText = await anthropicVisionComplete({
      apiKey: env.ANTHROPIC_API_KEY,
      model,
      system,
      userText,
      imageBytes: input.imageBytes,
      mimeType: input.mimeType,
    });
  }

  const firstValue = tryParseJson(rawText);
  const repaired = await runWithZodRepair({
    schema: imageBriefSchema,
    firstValue,
    repair: async () => {
      const provider = getAiProvider(preferOpenAiVision ? "openai" : "anthropic");
      const repairedRaw = await provider.complete({
        model,
        jsonMode: true,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Repair this JSON to match the image brief schema.\nUser request: ${input.userRequest}\nPrevious:\n${rawText.slice(0, 6000)}`,
          },
        ],
      });
      return tryParseJson(repairedRaw);
    },
  });

  if (!repaired.ok) {
    throw new Error(repaired.reason || "Could not build an image brief from the reference");
  }

  const brief = repaired.data;
  if (brief.safety.depictsRealPerson) {
    throw new ImageSafetyError(
      SAFETY_REAL_PERSON_MESSAGE,
      "Describe a fictional character or a scene without identifying a real person.",
    );
  }
  if (brief.safety.depictsCopyrightedCharacterOrLogo) {
    throw new ImageSafetyError(
      SAFETY_COPYRIGHT_MESSAGE,
      "Describe an original character, mark, or layout in your own words.",
    );
  }

  return { brief, model, costCents: 2 };
}

async function anthropicVisionComplete(input: {
  apiKey?: string;
  model: string;
  system: string;
  userText: string;
  imageBytes: Buffer;
  mimeType: string;
}): Promise<string> {
  if (!input.apiKey) {
    // Fall back to OpenAI vision if Anthropic missing
    const env = getEnv();
    if (!env.OPENAI_API_KEY) {
      throw new Error(
        "Vision analysis requires ANTHROPIC_API_KEY or OPENAI_API_KEY",
      );
    }
    return openAiVisionComplete({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_VISION_MODEL || "gpt-4o",
      system: input.system,
      userText: input.userText,
      imageBytes: input.imageBytes,
      mimeType: input.mimeType,
    });
  }

  const mediaType =
    input.mimeType === "image/jpeg" || input.mimeType === "image/png" || input.mimeType === "image/webp" || input.mimeType === "image/gif"
      ? input.mimeType
      : "image/png";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 2000,
      system: input.system,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: input.imageBytes.toString("base64"),
              },
            },
            { type: "text", text: input.userText },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vision analysis failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = json.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("Vision analysis returned empty content");
  return text;
}

async function openAiVisionComplete(input: {
  apiKey: string;
  model: string;
  system: string;
  userText: string;
  imageBytes: Buffer;
  mimeType: string;
}): Promise<string> {
  const dataUrl = `data:${input.mimeType};base64,${input.imageBytes.toString("base64")}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        {
          role: "user",
          content: [
            { type: "text", text: input.userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI vision failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI vision returned empty content");
  return content;
}
