import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { recordCrmActivities, type RecordCrmActivityInput } from "@/services/crm-activity";
import { applyOptOut } from "@/services/opt-out";
import { logger } from "@/lib/logger";
import {
  canManageContacts,
  DESTRUCTIVE_CONTACT_ACTION_FORBIDDEN,
  managerOnlyContactAction,
} from "@/components/contacts/contact-permissions";
import { errorResponse, HttpError, readJsonBody } from "../_lib/http";
import { createLeadsForContacts, resolveTargetStage } from "../_lib/leads";

const BULK_MAX_CONTACTS = 500;

const ACTIONS = ["add_tag", "remove_tag", "add_to_pipeline", "opt_out", "delete"] as const;

const bodySchema = z
  .object({
    action: z.enum(ACTIONS, {
      errorMap: () => ({ message: `Action must be one of: ${ACTIONS.join(", ")}.` }),
    }),
    contactIds: z
      .array(z.string().trim().min(1).max(100), {
        required_error: "Select at least one contact.",
        invalid_type_error: "contactIds must be a list of contact ids.",
      })
      .min(1, "Select at least one contact.")
      .max(BULK_MAX_CONTACTS, `Bulk actions handle at most ${BULK_MAX_CONTACTS} contacts at a time.`),
    tagId: z.string().trim().min(1).max(100).optional().nullable(),
    stageId: z.string().trim().min(1).max(100).optional().nullable(),
  })
  .superRefine((body, ctx) => {
    if ((body.action === "add_tag" || body.action === "remove_tag") && !body.tagId) {
      ctx.addIssue({ code: "custom", path: ["tagId"], message: "Choose a tag." });
    }
  });

type BulkResult = {
  action: (typeof ACTIONS)[number];
  requested: number;
  /** Live contacts of this workspace among the ids sent. */
  matched: number;
  /** Contacts actually changed. */
  updated: number;
  /** Matched contacts left alone (already tagged, already in pipeline, already opted out…). */
  unchanged: number;
  /** Matched contacts the action failed for (opt_out only — the others went through). */
  failed: number;
  /** Ids that are not live contacts of this workspace. */
  notFound: number;
};

/**
 * POST /api/contacts/bulk — { action, contactIds (≤500), tagId?, stageId? }.
 * Actions: add_tag, remove_tag, add_to_pipeline, opt_out, delete (soft).
 * Every id is checked against this workspace's live contacts; others are ignored and counted
 * as notFound. delete and opt_out need leads:write AND pipeline:manage (Owner / Administrator /
 * Manager). opt_out runs per contact: when some fail the response is still 200, with `failed`
 * counting them (the rest are opted out and recorded).
 */
export async function POST(req: Request) {
  try {
    const raw = await readJsonBody(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = bodySchema.parse(raw);
    if (body.action === "delete" && !canManageContacts(session.role)) {
      throw new HttpError(403, DESTRUCTIVE_CONTACT_ACTION_FORBIDDEN);
    }
    if (body.action === "opt_out" && !canManageContacts(session.role)) {
      throw new HttpError(403, managerOnlyContactAction("opting out many contacts at once"));
    }
    const organisationId = session.organisationId;
    const requestedIds = [...new Set(body.contactIds)];

    const contacts = await prisma.contact.findMany({
      where: { id: { in: requestedIds }, organisationId, deletedAt: null },
      select: { id: true, optedOut: true },
    });
    const ids = contacts.map((c) => c.id);
    const result: BulkResult = {
      action: body.action,
      requested: requestedIds.length,
      matched: ids.length,
      updated: 0,
      unchanged: 0,
      failed: 0,
      notFound: requestedIds.length - ids.length,
    };
    const activity = (contactId: string, input: Omit<RecordCrmActivityInput, "organisationId" | "contactId">) => ({
      organisationId,
      contactId,
      createdByUserId: session.userId,
      ...input,
    });
    let activities: RecordCrmActivityInput[] = [];

    if (body.action === "add_tag" || body.action === "remove_tag") {
      const tag = await prisma.tag.findFirst({
        where: { id: body.tagId!, organisationId },
        select: { id: true, name: true },
      });
      if (!tag) throw new HttpError(404, "Tag not found");
      const existing = ids.length
        ? await prisma.contactTag.findMany({
            where: { tagId: tag.id, contactId: { in: ids } },
            select: { contactId: true },
          })
        : [];
      const tagged = new Set(existing.map((e) => e.contactId));

      let changed: string[];
      if (body.action === "add_tag") {
        changed = ids.filter((id) => !tagged.has(id));
        if (changed.length) {
          await prisma.contactTag.createMany({
            data: changed.map((contactId) => ({ contactId, tagId: tag.id })),
            skipDuplicates: true,
          });
        }
      } else {
        changed = ids.filter((id) => tagged.has(id));
        if (changed.length) {
          await prisma.contactTag.deleteMany({ where: { tagId: tag.id, contactId: { in: changed } } });
        }
      }
      const added = body.action === "add_tag";
      activities = changed.map((contactId) =>
        activity(contactId, {
          kind: "tagged",
          title: added ? `Tagged "${tag.name}"` : `Removed tag "${tag.name}"`,
          metadata: { [added ? "added" : "removed"]: [{ id: tag.id, name: tag.name }], bulk: true },
        }),
      );
      result.updated = changed.length;
    } else if (body.action === "add_to_pipeline") {
      const target = await resolveTargetStage(organisationId, body.stageId);
      const { created } = await createLeadsForContacts({
        organisationId,
        contactIds: ids,
        target,
        userId: session.userId,
      });
      activities = created.map((lead) =>
        activity(lead.contactId, {
          kind: "added_to_pipeline",
          title: `Added to pipeline · ${target.stage.name}`,
          leadId: lead.id,
          metadata: { pipelineId: target.pipelineId, stageId: target.stage.id, stageName: target.stage.name, bulk: true },
        }),
      );
      result.updated = created.length;
    } else if (body.action === "opt_out") {
      const toOptOut = contacts.filter((c) => !c.optedOut).map((c) => c.id);
      // applyOptOut writes the suppression, domain event and cancels follow-ups per contact;
      // a few at a time keeps the connection pool free for everyone else. Each contact commits
      // on its own, so one failure must not hide (or skip recording) the ones that went through.
      const optedOut: string[] = [];
      for (let i = 0; i < toOptOut.length; i += 5) {
        const batch = toOptOut.slice(i, i + 5);
        const settled = await Promise.allSettled(
          batch.map((contactId) =>
            applyOptOut({ organisationId, contactId, userId: session.userId, source: "manual_bulk" }),
          ),
        );
        settled.forEach((outcome, index) => {
          if (outcome.status === "fulfilled") {
            optedOut.push(batch[index]!);
          } else {
            result.failed += 1;
            logger.warn("Bulk opt-out failed for a contact", {
              organisationId,
              contactId: batch[index],
              message: outcome.reason instanceof Error ? outcome.reason.message : "unknown",
            });
          }
        });
      }
      activities = optedOut.map((contactId) =>
        activity(contactId, { kind: "contact_updated", title: "Opted out", metadata: { optedOut: true, bulk: true } }),
      );
      result.updated = optedOut.length;
    } else {
      const { count } = ids.length
        ? await prisma.contact.updateMany({
            where: { id: { in: ids }, organisationId, deletedAt: null },
            data: { deletedAt: new Date() },
          })
        : { count: 0 };
      activities = ids.map((contactId) =>
        activity(contactId, { kind: "contact_updated", title: "Contact deleted", metadata: { deleted: true, bulk: true } }),
      );
      result.updated = count;
      await writeAuditLog({
        organisationId,
        userId: session.userId,
        action: "contacts.bulk_delete",
        entityType: "Contact",
        entityId: organisationId,
        metadata: { count, contactIds: ids },
      }).catch(() => undefined);
    }

    result.unchanged = result.matched - result.updated - result.failed;
    await recordCrmActivities(activities);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error, "The bulk action");
  }
}
