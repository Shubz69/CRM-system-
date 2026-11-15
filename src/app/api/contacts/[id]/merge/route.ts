import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { recordCrmActivity } from "@/services/crm-activity";
import {
  canManageContacts,
  DESTRUCTIVE_CONTACT_ACTION_FORBIDDEN,
} from "@/components/contacts/contact-permissions";
import { errorResponse, HttpError, readJsonBody } from "../../_lib/http";
import {
  asRecord,
  collapseLiveLeads,
  mergeContactSelect,
  mergedContactFields,
  repointPendingApprovals,
} from "../../_lib/merge";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  duplicateId: z
    .string({ required_error: "Choose the duplicate contact to merge." })
    .trim()
    .min(1, "Choose the duplicate contact to merge.")
    .max(100),
});

/**
 * POST /api/contacts/[id]/merge — { duplicateId }. Keeps [id], folds the duplicate into it:
 * every contact-owned row (conversations, leads, deals, notes, bookings, follow-ups,
 * attribution, suppressions, activities, identifiers, prospects, outreach threads, outbound
 * dispatches, tags) moves over in one transaction, empty fields are filled from the duplicate
 * (a do-not-contact or opt-out on either survives), the kept contact is left with one live
 * lead, pending approvals are re-pointed at the kept contact / lead, and the duplicate is
 * soft-deleted with metadata.mergedInto.
 *
 * Needs leads:write AND pipeline:manage (Owner / Administrator / Manager).
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const raw = await readJsonBody(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    if (!canManageContacts(session.role)) {
      throw new HttpError(403, DESTRUCTIVE_CONTACT_ACTION_FORBIDDEN);
    }
    const { id } = await params;
    const { duplicateId } = bodySchema.parse(raw);
    if (duplicateId === id) throw new HttpError(400, "A contact can't be merged into itself.");

    const organisationId = session.organisationId;
    const [kept, dup] = await Promise.all([
      prisma.contact.findFirst({ where: { id, organisationId, deletedAt: null }, select: mergeContactSelect }),
      prisma.contact.findFirst({
        where: { id: duplicateId, organisationId, deletedAt: null },
        select: mergeContactSelect,
      }),
    ]);
    if (!kept) throw new HttpError(404, "Contact not found");
    if (!dup) throw new HttpError(404, "Duplicate contact not found");

    const now = new Date();
    const moved = await prisma.$transaction(
      async (tx) => {
        // Lock both rows in a fixed order (no deadlock between A→B and B→A merges). A waiting
        // merge re-checks deletedAt after the lock, so only one of two racing merges proceeds.
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "Contact"
          WHERE "id" IN (${kept.id}, ${dup.id})
            AND "organisationId" = ${organisationId}
            AND "deletedAt" IS NULL
          ORDER BY "id"
          FOR UPDATE
        `);
        if (locked.length !== 2) {
          throw new HttpError(409, "One of these contacts was merged or deleted in the meantime. Reload and try again.");
        }
        // Fresh copies under the lock — the fill-in below must not work from a stale read.
        const keptNow = await tx.contact.findFirst({ where: { id: kept.id, organisationId }, select: mergeContactSelect });
        const dupNow = await tx.contact.findFirst({ where: { id: dup.id, organisationId }, select: mergeContactSelect });
        const keptRow = keptNow ?? kept;
        const dupRow = dupNow ?? dup;

        const claimed = await tx.contact.updateMany({
          where: { id: dup.id, organisationId, deletedAt: null },
          data: {
            deletedAt: now,
            metadata: {
              ...asRecord(dupRow.metadata),
              mergedInto: kept.id,
              mergedAt: now.toISOString(),
              mergedByUserId: session.userId,
            } as Prisma.InputJsonValue,
          },
        });
        if (claimed.count !== 1) throw new HttpError(409, "That contact was already merged or deleted.");

        const from = { contactId: dup.id, organisationId };
        const to = { contactId: kept.id };
        // Sequential on purpose: one interactive transaction = one connection.
        const conversations = (await tx.conversation.updateMany({ where: from, data: to })).count;
        const leads = (await tx.lead.updateMany({ where: from, data: to })).count;
        const deals = (await tx.deal.updateMany({ where: from, data: to })).count;
        const notes = (await tx.note.updateMany({ where: from, data: to })).count;
        const bookings = (await tx.booking.updateMany({ where: from, data: to })).count;
        const followUps = (await tx.followUp.updateMany({ where: from, data: to })).count;
        const attributions = (await tx.attribution.updateMany({ where: from, data: to })).count;
        const suppressions = (await tx.contactSuppression.updateMany({ where: from, data: to })).count;
        const activities = (await tx.crmActivity.updateMany({ where: from, data: to })).count;
        // Moving an identifier only changes contactId; (organisationId, channel, identifier)
        // stays the same, so this can never break that unique constraint. It must move: the
        // inbound pipeline resolves identifiers even on deleted contacts and would revive the
        // duplicate on the next DM.
        const identifiers = (await tx.contactIdentifier.updateMany({ where: from, data: to })).count;
        const socialProspects = (await tx.socialProspect.updateMany({ where: from, data: to })).count;
        const outreachThreads = (await tx.socialOutreachThread.updateMany({ where: from, data: to })).count;
        const outboundDispatches = (await tx.outboundDispatch.updateMany({ where: from, data: to })).count;

        // Tags: copy pairs the kept contact doesn't have yet, then drop the duplicate's.
        const dupTags = await tx.contactTag.findMany({ where: { contactId: dup.id }, select: { tagId: true } });
        const tags = dupTags.length
          ? (
              await tx.contactTag.createMany({
                data: dupTags.map((t) => ({ contactId: kept.id, tagId: t.tagId })),
                skipDuplicates: true,
              })
            ).count
          : 0;
        if (dupTags.length) await tx.contactTag.deleteMany({ where: { contactId: dup.id } });

        // One person, one live lead: keep the best of the leads now on the kept contact.
        const leadMerge = await collapseLiveLeads(tx, {
          organisationId,
          contactId: kept.id,
          at: now,
          userId: session.userId,
        });
        // Pending approvals (AI reply drafts, automation actions) must follow the records they
        // act on, or approving them later fails on the merged-away contact / lead.
        const approvalIds = new Set([
          ...(await repointPendingApprovals(tx, { organisationId, key: "contactId", from: [dup.id], to: kept.id })),
          ...(leadMerge.keptLeadId
            ? await repointPendingApprovals(tx, {
                organisationId,
                key: "leadId",
                from: leadMerge.droppedLeadIds,
                to: leadMerge.keptLeadId,
              })
            : []),
        ]);

        await tx.contact.update({
          where: { id: kept.id },
          data: mergedContactFields(keptRow, dupRow, { at: now, userId: session.userId }),
        });

        return {
          conversations,
          leads,
          deals,
          notes,
          bookings,
          followUps,
          attributions,
          suppressions,
          activities,
          identifiers,
          socialProspects,
          outreachThreads,
          outboundDispatches,
          tags,
          leadsMergedAway: leadMerge.droppedLeadIds.length,
          approvals: approvalIds.size,
        };
      },
      { timeout: 30_000 },
    );

    const dupName = dup.fullName?.trim() || dup.email || dup.instagramUsername || "a duplicate contact";
    await recordCrmActivity({
      organisationId,
      kind: "merged",
      title: `Merged ${dupName} into this contact`,
      contactId: kept.id,
      createdByUserId: session.userId,
      metadata: { duplicateId: dup.id, moved },
    });
    await writeAuditLog({
      organisationId,
      userId: session.userId,
      action: "contacts.merge",
      entityType: "Contact",
      entityId: kept.id,
      metadata: { duplicateId: dup.id, moved },
    }).catch(() => undefined);

    return Response.json({ ok: true, keptId: kept.id, mergedId: dup.id, moved });
  } catch (error) {
    return errorResponse(error, "Merging contacts");
  }
}
