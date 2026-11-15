import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * CRM activity timeline (CrmActivity rows). Everything a person — or the system — does to
 * a contact, lead or deal lands here so the contact page can show one history.
 *
 * Recording is best-effort: a failed timeline write must never fail the action itself.
 */
export type CrmActivityKind =
  | "stage_changed"
  | "qualification_changed"
  | "added_to_pipeline"
  | "note"
  | "reply_sent"
  | "booking"
  | "deal_created"
  | "deal_updated"
  | "tagged"
  | "imported"
  | "merged"
  | "contact_updated"
  | "call"
  | "meeting"
  | "task";

/** Kinds a person can log by hand from the timeline. */
export const MANUAL_ACTIVITY_KINDS: CrmActivityKind[] = ["call", "meeting", "task", "note"];

export type RecordCrmActivityInput = {
  organisationId: string;
  kind: CrmActivityKind;
  title: string;
  body?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  dealId?: string | null;
  companyId?: string | null;
  createdByUserId?: string | null;
  dueAt?: Date | null;
  metadata?: Record<string, unknown>;
};

function toData(input: RecordCrmActivityInput): Prisma.CrmActivityCreateManyInput {
  return {
    organisationId: input.organisationId,
    kind: input.kind,
    title: input.title.slice(0, 300),
    body: input.body ?? null,
    contactId: input.contactId ?? null,
    leadId: input.leadId ?? null,
    dealId: input.dealId ?? null,
    companyId: input.companyId ?? null,
    createdByUserId: input.createdByUserId ?? null,
    dueAt: input.dueAt ?? null,
    metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
  };
}

/** Record one activity. Never throws. */
export async function recordCrmActivity(input: RecordCrmActivityInput): Promise<void> {
  try {
    await prisma.crmActivity.create({ data: toData(input) });
  } catch (error) {
    logger.warn("CRM activity not recorded", {
      kind: input.kind,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

/** Record many activities in one insert (bulk actions, imports). Never throws. */
export async function recordCrmActivities(inputs: RecordCrmActivityInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await prisma.crmActivity.createMany({ data: inputs.map(toData) });
  } catch (error) {
    logger.warn("CRM activities not recorded", {
      count: inputs.length,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}
