import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { recordCrmActivities } from "@/services/crm-activity";
import { readJsonObject, RouteError, routeErrorResponse } from "../_lib/http";
import { moveLeadsMarkedHuman } from "../_lib/move-leads";

const MAX_BULK_LEADS = 500;

const bulkSchema = z.object({
  leadIds: z
    .array(z.string().min(1, "Lead ids can't be empty"), {
      required_error: "leadIds is required",
      invalid_type_error: "leadIds must be a list of lead ids",
    })
    .min(1, "Select at least one lead")
    .max(MAX_BULK_LEADS, `You can move at most ${MAX_BULK_LEADS} leads at once`),
  stageId: z
    .string({ required_error: "stageId is required", invalid_type_error: "stageId must be text" })
    .min(1, "stageId is required"),
});

/**
 * Move many leads to one stage. Each moved lead is marked as a person's decision
 * (exactly like the single-move PATCH), so inbound AI analysis won't move it again.
 * Ids that aren't live leads of this workspace are ignored and counted as `notFound`.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await readJsonObject(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = bulkSchema.parse(raw);
    const leadIds = [...new Set(body.leadIds)];

    const stage = await prisma.pipelineStage.findFirst({
      where: { id: body.stageId, pipeline: { organisationId: session.organisationId } },
      select: { id: true, name: true },
    });
    if (!stage) throw new RouteError(404, "Stage not found");

    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds }, organisationId: session.organisationId, deletedAt: null },
      select: {
        id: true,
        contactId: true,
        stageId: true,
        stage: { select: { name: true } },
      },
    });
    if (leads.length === 0) throw new RouteError(404, "None of the selected leads were found");

    const toMove = leads.filter((lead) => lead.stageId !== stage.id);
    const now = new Date();
    if (toMove.length > 0) {
      await moveLeadsMarkedHuman({
        organisationId: session.organisationId,
        leadIds: toMove.map((lead) => lead.id),
        stageId: stage.id,
        userId: session.userId,
        now,
      });

      await recordCrmActivities(
        toMove.map((lead) => ({
          organisationId: session.organisationId,
          kind: "stage_changed" as const,
          title: `Moved to ${stage.name}`,
          contactId: lead.contactId,
          leadId: lead.id,
          createdByUserId: session.userId,
          metadata: {
            fromStageId: lead.stageId,
            fromStageName: lead.stage?.name ?? null,
            toStageId: stage.id,
            toStageName: stage.name,
            bulk: true,
          },
        })),
      );

      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "lead.stage_bulk_moved",
        entityType: "PipelineStage",
        entityId: stage.id,
        metadata: {
          stageId: stage.id,
          stage: stage.name,
          count: toMove.length,
          leadIds: toMove.map((lead) => lead.id),
        },
      });
    }

    return Response.json({
      ok: true,
      moved: toMove.length,
      unchanged: leads.length - toMove.length,
      notFound: leadIds.length - leads.length,
    });
  } catch (error) {
    return routeErrorResponse(error, "Moving leads");
  }
}
