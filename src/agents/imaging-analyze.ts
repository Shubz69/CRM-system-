import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { imageBriefSchema } from "@/adapters/images/brief";
import {
  estimateImageGenerationCostCents,
} from "@/adapters/images";
import { analyseReferenceImage } from "@/services/image-vision";
import { loadAssetBytes } from "@/services/assets";
import { prisma } from "@/lib/db";

export const imagingAnalyzeInputSchema = z.object({
  request: z.string().min(1).max(4000),
  referenceAssetId: z.string().min(1),
});

export const imagingAnalyzeOutputSchema = z.object({
  awaitPromptConfirm: z.literal(true),
  brief: imageBriefSchema,
  proposedPrompt: z.string().min(1),
  estimatedCostCents: z.number().int().nonnegative(),
  referenceAssetId: z.string(),
  summary: z.string(),
});

export type ImagingAnalyzeInput = z.infer<typeof imagingAnalyzeInputSchema>;
export type ImagingAnalyzeOutput = z.infer<typeof imagingAnalyzeOutputSchema>;

/**
 * Analyses a reference image into a structured brief + proposed prompt.
 * Does not generate — the supervisor pauses for user edit/confirm.
 */
export const imagingAnalyzeAgent: Agent<ImagingAnalyzeInput, ImagingAnalyzeOutput> = {
  name: "imaging_analyze",
  description:
    "Looks at a reference image and drafts an editable generation prompt before spending on image creation.",
  inputSchema: imagingAnalyzeInputSchema,
  outputSchema: imagingAnalyzeOutputSchema,
  tier: "balanced",
  estimateCostCents: () => 2,
  userFacingLabel: (input) => {
    const snippet = (input.request || "your idea").trim().slice(0, 60);
    return `Studying your reference to draft a prompt for “${snippet}”`;
  },
  async execute(input, ctx) {
    const parsed = imagingAnalyzeInputSchema.parse(input);
    const loaded = await loadAssetBytes({
      organisationId: ctx.organisationId,
      assetId: parsed.referenceAssetId,
    });
    if (!loaded) {
      throw new Error("Reference image not found for this organisation");
    }

    const { brief, model, costCents } = await analyseReferenceImage({
      organisationId: ctx.organisationId,
      userRequest: parsed.request,
      imageBytes: loaded.bytes,
      mimeType: loaded.mimeType,
    });

    const estimatedCostCents = estimateImageGenerationCostCents();
    const output: ImagingAnalyzeOutput = {
      awaitPromptConfirm: true,
      brief,
      proposedPrompt: brief.proposedPrompt,
      estimatedCostCents,
      referenceAssetId: parsed.referenceAssetId,
      summary:
        "Here's the prompt I derived from your reference. Edit it if anything looks off, then confirm to generate.",
    };

    await prisma.agentRun.updateMany({
      where: { id: ctx.agentRunId, organisationId: ctx.organisationId },
      data: {
        referenceAssetId: parsed.referenceAssetId,
        pendingPrompt: brief.proposedPrompt,
        pendingBrief: brief as unknown as Prisma.InputJsonValue,
        pendingCostEstimateCents: estimatedCostCents,
      },
    });

    return { output, model, costCents };
  },
};
