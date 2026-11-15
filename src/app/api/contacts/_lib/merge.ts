import { Prisma } from "@prisma/client";

export const mergeContactSelect = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  instagramUsername: true,
  location: true,
  timezone: true,
  leadSource: true,
  campaignSource: true,
  companyId: true,
  messagingChannelId: true,
  firstContactAt: true,
  lastContactAt: true,
  optedOut: true,
  optedOutAt: true,
  consentGiven: true,
  metadata: true,
} satisfies Prisma.ContactSelect;

export type MergeContact = Prisma.ContactGetPayload<{ select: typeof mergeContactSelect }>;

/** Text fields copied from the duplicate when the kept contact has none. */
const FILLABLE_TEXT = [
  "fullName",
  "email",
  "phone",
  "instagramUsername",
  "location",
  "timezone",
  "leadSource",
  "campaignSource",
] as const;

/** Metadata keys carried over: do-not-contact flags (never lose them) and manual details. */
const CARRIED_METADATA = [
  "DO_NOT_CONTACT",
  "doNotContact",
  "do_not_contact",
  "contactability",
  "optOutSource",
  "optOutReason",
  "jobTitle",
  "notes",
] as const;

/**
 * Do-not-contact flags, read exactly as the send path reads them
 * (metadataBlocksContact in services/messaging/contactability.ts).
 */
const DNC_FLAGS = ["DO_NOT_CONTACT", "doNotContact", "do_not_contact"] as const;

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** True when the metadata marks the contact do-not-contact (blocks every send). */
export function metadataBlocksContact(metadata: unknown): boolean {
  const meta = asRecord(metadata);
  return DNC_FLAGS.some((flag) => meta[flag] === true) || meta.contactability === "DO_NOT_CONTACT";
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

/** What the kept contact gains from the duplicate. Never overwrites a value it already has. */
export function mergedContactFields(
  kept: MergeContact,
  dup: MergeContact,
  merge: { at: Date; userId: string },
): Prisma.ContactUncheckedUpdateInput {
  const data: Prisma.ContactUncheckedUpdateInput = {};
  for (const field of FILLABLE_TEXT) {
    if (isBlank(kept[field]) && !isBlank(dup[field])) data[field] = dup[field];
  }
  if (!kept.companyId && dup.companyId) data.companyId = dup.companyId;
  if (!kept.messagingChannelId && dup.messagingChannelId) data.messagingChannelId = dup.messagingChannelId;
  if (dup.firstContactAt < kept.firstContactAt) data.firstContactAt = dup.firstContactAt;
  if (dup.lastContactAt > kept.lastContactAt) data.lastContactAt = dup.lastContactAt;
  // An opt-out on either record must survive the merge.
  if (dup.optedOut && !kept.optedOut) {
    data.optedOut = true;
    data.optedOutAt = dup.optedOutAt ?? merge.at;
  }
  if (!dup.consentGiven && kept.consentGiven) data.consentGiven = false;

  const keptMeta = asRecord(kept.metadata);
  const dupMeta = asRecord(dup.metadata);
  const metadata: Record<string, unknown> = { ...keptMeta };
  for (const key of CARRIED_METADATA) {
    if (isBlank(metadata[key]) && !isBlank(dupMeta[key])) metadata[key] = dupMeta[key];
  }
  // A do-not-contact on the duplicate wins over a "contactable" value on the kept contact
  // (e.g. doNotContact: false, contactability: "CONTACTABLE"), so the kept contact stays blocked.
  for (const flag of DNC_FLAGS) {
    if (dupMeta[flag] === true) metadata[flag] = true;
  }
  if (dupMeta.contactability === "DO_NOT_CONTACT") metadata.contactability = "DO_NOT_CONTACT";
  const previous = Array.isArray(keptMeta.mergedFrom) ? keptMeta.mergedFrom : [];
  metadata.mergedFrom = [
    ...previous,
    { contactId: dup.id, mergedAt: merge.at.toISOString(), mergedByUserId: merge.userId },
  ];
  data.metadata = metadata as Prisma.InputJsonValue;
  return data;
}

type Tx = Prisma.TransactionClient;

export type MergeLeadRow = {
  id: string;
  conversationId: string | null;
  metadata: unknown;
  updatedAt: Date;
  stage: { position: number; isLost: boolean } | null;
};

/** How far along the funnel a lead is: stage position, with lost and stageless leads last. */
function leadProgress(lead: MergeLeadRow): number {
  if (!lead.stage) return -2;
  return lead.stage.isLost ? -1 : lead.stage.position;
}

/**
 * The live lead a merged contact keeps: one a person placed (metadata.stageChangedBy
 * "HUMAN"), else the most advanced by stage position (lost / stageless count as least
 * advanced), else the most recently updated.
 */
export function pickLeadToKeep<T extends MergeLeadRow>(leads: T[]): T | null {
  const human = (lead: T) => (asRecord(lead.metadata).stageChangedBy === "HUMAN" ? 1 : 0);
  const ranked = [...leads].sort(
    (a, b) =>
      human(b) - human(a) ||
      leadProgress(b) - leadProgress(a) ||
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  return ranked[0] ?? null;
}

/**
 * After a merge moved the duplicate's leads over, leave the kept contact ONE live lead.
 * Deals, bookings, follow-ups, activities, attributions and qualification answers of the
 * other leads move to it; the others are soft-deleted with metadata.mergedInto (the inbound
 * pipeline follows that when their conversation writes again). The kept lead takes over a
 * dropped lead's conversation when it has none. Score history stays with the lead it scored.
 */
export async function collapseLiveLeads(
  tx: Tx,
  input: { organisationId: string; contactId: string; at: Date; userId: string },
): Promise<{ keptLeadId: string | null; droppedLeadIds: string[] }> {
  const { organisationId, at } = input;
  const leads = await tx.lead.findMany({
    where: { organisationId, contactId: input.contactId, deletedAt: null },
    select: {
      id: true,
      conversationId: true,
      metadata: true,
      updatedAt: true,
      stage: { select: { position: true, isLost: true } },
    },
  });
  const keep = pickLeadToKeep(leads);
  if (!keep || leads.length < 2) return { keptLeadId: keep?.id ?? null, droppedLeadIds: [] };

  const dropped = leads.filter((lead) => lead.id !== keep.id);
  const droppedLeadIds = dropped.map((lead) => lead.id);
  const from = { organisationId, leadId: { in: droppedLeadIds } };
  const to = { leadId: keep.id };
  // Sequential on purpose: one interactive transaction = one connection.
  await tx.deal.updateMany({ where: from, data: to });
  await tx.booking.updateMany({ where: from, data: to });
  await tx.followUp.updateMany({ where: from, data: to });
  await tx.crmActivity.updateMany({ where: from, data: to });
  await tx.attribution.updateMany({ where: from, data: to });
  // One answer per (lead, field): bring over only the fields the kept lead hasn't answered.
  for (const lead of dropped) {
    const answered = await tx.qualificationAnswer.findMany({ where: { leadId: keep.id }, select: { fieldId: true } });
    await tx.qualificationAnswer.updateMany({
      where: { leadId: lead.id, fieldId: { notIn: answered.map((a) => a.fieldId) } },
      data: to,
    });
  }

  if (!keep.conversationId) {
    const withConversation = dropped
      .filter((lead) => lead.conversationId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    if (withConversation) {
      await tx.lead.updateMany({
        where: { id: keep.id, organisationId },
        data: { conversationId: withConversation.conversationId },
      });
    }
  }

  for (const lead of dropped) {
    await tx.lead.updateMany({
      where: { id: lead.id, organisationId, deletedAt: null },
      data: {
        deletedAt: at,
        metadata: {
          ...asRecord(lead.metadata),
          mergedInto: keep.id,
          mergedAt: at.toISOString(),
          mergedByUserId: input.userId,
        } as Prisma.InputJsonValue,
      },
    });
  }
  return { keptLeadId: keep.id, droppedLeadIds };
}

/**
 * Point this workspace's PENDING approval requests whose payload names one of `from` (at
 * payload.<key> or payload.context.<key>) at `to` — otherwise approving them later acts on a
 * merged-away contact or lead and sends nothing. Returns the ids of the requests changed.
 */
export async function repointPendingApprovals(
  tx: Tx,
  input: { organisationId: string; key: "contactId" | "leadId"; from: string[]; to: string },
): Promise<string[]> {
  if (!input.from.length) return [];
  const ids = new Set<string>();
  for (const path of [[input.key], ["context", input.key]]) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "ApprovalRequest"
      SET "payload" = jsonb_set("payload", ${path}::text[], to_jsonb(${input.to}::text)),
          "updatedAt" = NOW()
      WHERE "organisationId" = ${input.organisationId}
        AND "status" = 'PENDING'
        AND "payload" #>> ${path}::text[] = ANY(${input.from}::text[])
      RETURNING "id"
    `);
    for (const row of rows ?? []) ids.add(row.id);
  }
  return [...ids];
}
