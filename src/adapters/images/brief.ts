import { z } from "zod";

/** Structured vision brief — validated before it becomes a generation prompt. */
export const imageBriefSchema = z.object({
  composition: z.string().min(1).max(800),
  colourPalette: z.array(z.string().min(1).max(80)).min(1).max(12),
  style: z.string().min(1).max(400),
  subject: z.string().min(1).max(800),
  mood: z.string().min(1).max(400),
  textTreatment: z.string().min(1).max(400),
  /** Draft generation prompt derived from the brief + user request. */
  proposedPrompt: z.string().min(8).max(4000),
  safety: z.object({
    depictsRealPerson: z.boolean(),
    depictsCopyrightedCharacterOrLogo: z.boolean(),
    notes: z.string().max(800).optional(),
  }),
});

export type ImageBrief = z.infer<typeof imageBriefSchema>;

export function buildGenerationPromptFromBrief(
  brief: ImageBrief,
  userRequest: string,
  editedPrompt?: string,
): string {
  if (editedPrompt?.trim()) return editedPrompt.trim().slice(0, 4000);
  return brief.proposedPrompt.trim().slice(0, 4000) || userRequest.trim().slice(0, 4000);
}

export function assertImageBriefSafe(brief: ImageBrief): void {
  if (brief.safety.depictsRealPerson) {
    throw new Error("SAFETY_REAL_PERSON");
  }
  if (brief.safety.depictsCopyrightedCharacterOrLogo) {
    throw new Error("SAFETY_COPYRIGHTED_IP");
  }
}

export const SAFETY_REAL_PERSON_MESSAGE =
  "I can't create images of real, identifiable people. Try describing a fictional character, a stylised silhouette, or a scene without naming a real person.";

export const SAFETY_COPYRIGHT_MESSAGE =
  "I can't reproduce copyrighted characters, logos, or branded IP. Describe an original character or mark in your own words, and I'll work from that instead.";
