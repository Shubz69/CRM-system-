import { QualificationStatus as PrismaQualificationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { AiAnalysis } from "@/schemas/ai";

export const QUALIFICATION_STATUSES = [
  "QUALIFIED",
  "POTENTIALLY_QUALIFIED",
  "NEEDS_INFORMATION",
  "NOT_QUALIFIED",
] as const;

export type QualificationResultStatus = (typeof QUALIFICATION_STATUSES)[number];

export const QUALIFICATION_STATUS_MAP: Record<
  PrismaQualificationStatus,
  QualificationResultStatus
> = {
  [PrismaQualificationStatus.QUALIFIED]: "QUALIFIED",
  [PrismaQualificationStatus.QUALIFYING]: "POTENTIALLY_QUALIFIED",
  [PrismaQualificationStatus.UNKNOWN]: "NEEDS_INFORMATION",
  [PrismaQualificationStatus.DISQUALIFIED]: "NOT_QUALIFIED",
};

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
    where: {
      leadId: input.leadId,
      lead: { organisationId: input.organisationId },
    },
  });
  const answered = new Set(answers.map((a) => a.fieldId));

  return fields.filter((f) => !answered.has(f.id)).map((f) => f.key);
}

export function nextQualificationQuestion(
  fields: Array<{
    key: string;
    label: string;
    required: boolean;
    priority?: number;
    position?: number;
  }>,
  answersCollected: Record<string, string>,
  missingFromAi: string[],
): string | null {
  const missing = new Set(missingFromAi);
  const unanswered = fields
    .filter(
      (field) =>
        field.required && (!answersCollected[field.key]?.trim() || missing.has(field.key)),
    )
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    )[0];
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
  analysis: Pick<AiAnalysis, "answers_collected" | "qualification_status">;
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

export async function evaluateQualification(input: {
  organisationId: string;
  leadId: string;
}): Promise<{
  status: QualificationResultStatus;
  reasons: string[];
  missingFields: string[];
}> {
  const answers = await prisma.qualificationAnswer.findMany({
    where: {
      leadId: input.leadId,
      lead: { organisationId: input.organisationId },
    },
    include: { field: { select: { key: true } } },
  });
  const answersCollected = Object.fromEntries(
    answers.map((answer) => [answer.field.key, answer.value]),
  );
  const missingFields = await getMissingQualificationFields(input);
  const disqualified = await applyDisqualificationFromAnswers({
    ...input,
    analysis: {
      answers_collected: answersCollected,
      qualification_status: "unknown",
    },
  });

  if (disqualified) {
    return {
      status: "NOT_QUALIFIED",
      reasons: ["A configured disqualifying answer was supplied."],
      missingFields,
    };
  }
  if (missingFields.length > 0) {
    const hasAnswers = Object.keys(answersCollected).length > 0;
    return {
      status: hasAnswers ? "POTENTIALLY_QUALIFIED" : "NEEDS_INFORMATION",
      reasons: [`Missing required fields: ${missingFields.join(", ")}`],
      missingFields,
    };
  }
  return {
    status: "QUALIFIED",
    reasons: ["All required qualification fields are complete."],
    missingFields: [],
  };
}
