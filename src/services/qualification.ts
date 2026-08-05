import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { AiAnalysis } from "@/schemas/ai";

/**
 * Persist AI-collected answers against configured qualification fields.
 * Only stores answers for known field keys; never invents fields.
 */
export async function syncQualificationAnswers(input: {
  organisationId: string;
  leadId: string;
  answers: Record<string, string>;
}): Promise<number> {
  const fields = await prisma.qualificationField.findMany({
    where: { organisationId: input.organisationId, active: true },
  });

  let saved = 0;
  for (const field of fields) {
    const value = input.answers[field.key];
    if (value === undefined || value === "") continue;

    await prisma.qualificationAnswer.upsert({
      where: {
        leadId_fieldId: {
          leadId: input.leadId,
          fieldId: field.id,
        },
      },
      create: {
        leadId: input.leadId,
        fieldId: field.id,
        value: String(value),
      },
      update: { value: String(value) },
    });
    saved += 1;
  }

  return saved;
}

export async function getMissingQualificationFields(input: {
  organisationId: string;
  leadId: string;
}): Promise<string[]> {
  const fields = await prisma.qualificationField.findMany({
    where: { organisationId: input.organisationId, active: true, required: true },
    orderBy: { position: "asc" },
  });

  const answers = await prisma.qualificationAnswer.findMany({
    where: { leadId: input.leadId },
  });
  const answered = new Set(answers.map((a) => a.fieldId));

  return fields.filter((f) => !answered.has(f.id)).map((f) => f.key);
}

export function nextQualificationQuestion(
  fields: Array<{ key: string; label: string; required: boolean }>,
  answersCollected: Record<string, string>,
  missingFromAi: string[],
): string | null {
  const unanswered = fields.find((f) => !answersCollected[f.key]);
  if (unanswered) return unanswered.label;
  if (missingFromAi[0]) {
    const match = fields.find((f) => f.key === missingFromAi[0]);
    return match?.label ?? missingFromAi[0];
  }
  return null;
}

export async function applyDisqualificationFromAnswers(input: {
  organisationId: string;
  leadId: string;
  analysis: AiAnalysis;
}): Promise<boolean> {
  const fields = await prisma.qualificationField.findMany({
    where: { organisationId: input.organisationId, active: true },
  });

  for (const field of fields) {
    const disqualifying = Array.isArray((field as { disqualifyingAnswers?: unknown }).disqualifyingAnswers)
      ? ((field as { disqualifyingAnswers?: string[] }).disqualifyingAnswers ?? [])
      : [];
    const value = input.analysis.answers_collected[field.key];
    if (value && disqualifying.map((d) => d.toLowerCase()).includes(value.toLowerCase())) {
      logger.info("Disqualifying answer matched", {
        leadId: input.leadId,
        field: field.key,
        value,
      });
      return true;
    }
  }

  return input.analysis.qualification_status === "disqualified";
}
