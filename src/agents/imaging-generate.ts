import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import {
  getImageProvider,
  estimateImageGenerationCostCents,
  ImageSafetyError,
  ImageProviderNotConfiguredError,
} from "@/adapters/images";
import {
  SAFETY_COPYRIGHT_MESSAGE,
  SAFETY_REAL_PERSON_MESSAGE,
} from "@/adapters/images/brief";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { createGeneratedAsset, loadAssetBytes } from "@/services/assets";
import { prisma } from "@/lib/db";

export const imagingGenerateInputSchema = z.object({
  prompt: z.string().min(8).max(4000),
  referenceAssetId: z.string().min(1).optional(),
  request: z.string().max(4000).optional(),
});

export const imagingGenerateOutputSchema = z.object({
  assetId: z.string(),
  url: z.string().url(),
  prompt: z.string(),
  provider: z.string(),
  model: z.string(),
  costCents: z.number().int().nonnegative(),
  summary: z.string(),
});

export type ImagingGenerateInput = z.infer<typeof imagingGenerateInputSchema>;
export type ImagingGenerateOutput = z.infer<typeof imagingGenerateOutputSchema>;

function looksLikeUnsafePrompt(prompt: string): ImageSafetyError | null {
  const p = prompt.toLowerCase();
  if (
    /\b(photo of|portrait of|lookalike|celebrity|real person named)\b/i.test(prompt) &&
    /\b(elon|trump|biden|taylor swift|tom cruise|obama)\b/i.test(p)
  ) {
    return new ImageSafetyError(
      SAFETY_REAL_PERSON_MESSAGE,
      "Describe a fictional character instead.",
    );
  }
  if (
    /\b(mickey mouse|marvel|disney|nike swoosh|coca[- ]cola logo|harry potter|pokemon)\b/i.test(
      p,
    )
  ) {
    return new ImageSafetyError(
      SAFETY_COPYRIGHT_MESSAGE,
      "Describe an original character or mark in your own words.",
    );
  }
  return null;
}

/**
 * Generates an image from a confirmed prompt. Cost is gated and recorded on Asset + step.
 */
export const imagingGenerateAgent: Agent<ImagingGenerateInput, ImagingGenerateOutput> = {
  name: "imaging_generate",
  description: "Generates an image from a confirmed prompt and saves it as an organisation asset.",
  inputSchema: imagingGenerateInputSchema,
  outputSchema: imagingGenerateOutputSchema,
  tier: "heavy",
  estimateCostCents: () => estimateImageGenerationCostCents(),
  userFacingLabel: () => "Creating your image from the confirmed prompt",
  async execute(input, ctx) {
    const parsed = imagingGenerateInputSchema.parse(input);
    const unsafe = looksLikeUnsafePrompt(parsed.prompt);
    if (unsafe) {
      throw unsafe;
    }

    const estimate = estimateImageGenerationCostCents();
    await assertWithinSpendCap(ctx.organisationId, estimate);

    let reference:
      | {
          bytes: Buffer;
          mimeType: string;
        }
      | undefined;
    if (parsed.referenceAssetId) {
      const loaded = await loadAssetBytes({
        organisationId: ctx.organisationId,
        assetId: parsed.referenceAssetId,
      });
      if (loaded) {
        reference = { bytes: loaded.bytes, mimeType: loaded.mimeType };
      }
    }

    try {
      const provider = getImageProvider();
      const result = await provider.generate({
        organisationId: ctx.organisationId,
        prompt: parsed.prompt,
        referenceImage: reference,
        size: "1024x1024",
      });

      const run = await prisma.agentRun.findFirst({
        where: { id: ctx.agentRunId, organisationId: ctx.organisationId },
        select: { userId: true },
      });

      const asset = await createGeneratedAsset({
        organisationId: ctx.organisationId,
        userId: run?.userId,
        bytes: result.bytes,
        mimeType: result.mimeType,
        prompt: parsed.prompt,
        provider: result.provider,
        model: result.model,
        costCents: result.costCents,
        width: result.width,
        height: result.height,
        derivedFromAssetId: parsed.referenceAssetId ?? null,
      });

      await prisma.agentRun.updateMany({
        where: { id: ctx.agentRunId, organisationId: ctx.organisationId },
        data: {
          pendingPrompt: null,
          pendingBrief: Prisma.DbNull,
          pendingCostEstimateCents: null,
        },
      });

      const output: ImagingGenerateOutput = {
        assetId: asset.id,
        url: asset.url,
        prompt: parsed.prompt,
        provider: result.provider,
        model: result.model,
        costCents: result.costCents,
        summary: "Your image is ready.",
      };
      return { output, model: result.model, costCents: result.costCents };
    } catch (error) {
      if (error instanceof ImageProviderNotConfiguredError) {
        const wrapped = new Error(error.message) as Error & {
          userFacingMessage: string;
          alternativeSuggestion: string;
        };
        wrapped.userFacingMessage =
          "Image generation isn't set up yet. Ask an admin to configure OpenAI or Gemini image generation.";
        wrapped.alternativeSuggestion =
          "Until then, you can still upload references and draft prompts — generation will wait for configuration.";
        throw wrapped;
      }
      if (error instanceof ImageSafetyError) {
        throw error;
      }
      throw error;
    }
  },
};
