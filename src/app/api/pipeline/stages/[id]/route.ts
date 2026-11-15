import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { recordCrmActivities } from "@/services/crm-activity";
import { readJsonObject, RouteError, routeErrorResponse } from "../../_lib/http";
import {
  applyPositions,
  assertNameFree,
  isSystemStageSlug,
  listStages,
  lockPipeline,
  requireDefaultPipelineId,
  STAGE_SELECT,
  stageColorSchema,
  stageNameSchema,
  toStageDto,
} from "../../_lib/stages";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    name: stageNameSchema.optional(),
    color: stageColorSchema.optional(),
    isWon: z.boolean({ invalid_type_error: "isWon must be true or false" }).optional(),
    isLost: z.boolean({ invalid_type_error: "isLost must be true or false" }).optional(),
  })
  .refine((b) => !(b.isWon && b.isLost), { message: "A stage can't be both won and lost" })
  .refine(
    (b) => b.name !== undefined || b.color !== undefined || b.isWon !== undefined || b.isLost !== undefined,
    { message: "Nothing to update — send a name, colour or won/lost flag" },
  );

/** Rename / recolour / mark won-or-lost. The slug never changes. */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const raw = await readJsonObject(req);
    const session = await requirePermissionForMutation("pipeline:manage", req, raw);
    const body = patchSchema.parse(raw);
    const { id } = await params;
    const pipelineId = await requireDefaultPipelineId(session.organisationId);

    const { before, after } = await prisma.$transaction(async (tx) => {
      await lockPipeline(tx, pipelineId);
      const stages = await listStages(tx, pipelineId);
      // Only stages of this workspace's default pipeline — another workspace's id is a 404.
      const stage = stages.find((s) => s.id === id);
      if (!stage) throw new RouteError(404, "Stage not found");

      let isWon = stage.isWon;
      let isLost = stage.isLost;
      if (body.isWon !== undefined) {
        isWon = body.isWon;
        if (body.isWon) isLost = false;
      }
      if (body.isLost !== undefined) {
        isLost = body.isLost;
        if (body.isLost) isWon = false;
      }
      if (isSystemStageSlug(stage.slug) && (isWon !== stage.isWon || isLost !== stage.isLost)) {
        throw new RouteError(
          400,
          "Won/lost can't be changed on built-in stages — the AI relies on them. You can still rename, recolour or reorder it.",
        );
      }
      if (body.name !== undefined) assertNameFree(stages, body.name, stage.id);

      const updated = await tx.pipelineStage.update({
        where: { id: stage.id },
        // Display fields only: the slug is what automation and the AI match on.
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          isWon,
          isLost,
        },
        select: STAGE_SELECT,
      });
      return { before: stage, after: updated };
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "pipeline.stage_updated",
      entityType: "PipelineStage",
      entityId: after.id,
      metadata: {
        slug: after.slug,
        from: { name: before.name, color: before.color, isWon: before.isWon, isLost: before.isLost },
        to: { name: after.name, color: after.color, isWon: after.isWon, isLost: after.isLost },
      },
    });

    return Response.json({ stage: toStageDto(after) });
  } catch (error) {
    return routeErrorResponse(error, "Updating the stage");
  }
}

/**
 * Delete a custom stage. A stage that still has live leads needs `?moveLeadsTo=<stageId>`
 * (409 with the lead count otherwise). Every lead pointing at the stage — archived ones and
 * leads of deleted contacts too — moves before the delete (to `moveLeadsTo`, else the "new"
 * stage, else the first remaining stage), so none are left without a stage.
 * Built-in stages can't be deleted.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const session = await requirePermissionForMutation("pipeline:manage", req, null);
    const { id } = await params;
    const moveLeadsTo = new URL(req.url).searchParams.get("moveLeadsTo")?.trim() || null;
    const pipelineId = await requireDefaultPipelineId(session.organisationId);

    const result = await prisma.$transaction(async (tx) => {
      await lockPipeline(tx, pipelineId);
      const stages = await listStages(tx, pipelineId);
      const stage = stages.find((s) => s.id === id);
      if (!stage) throw new RouteError(404, "Stage not found");
      if (isSystemStageSlug(stage.slug)) {
        throw new RouteError(
          409,
          `"${stage.name}" is a built-in stage the AI moves leads into, so it can't be deleted. You can rename or reorder it instead.`,
          { code: "SYSTEM_STAGE" },
        );
      }

      // Live = what the board shows: not deleted, contact not deleted.
      const liveLeads = await tx.lead.findMany({
        where: {
          organisationId: session.organisationId,
          stageId: stage.id,
          deletedAt: null,
          contact: { deletedAt: null },
        },
        select: { id: true, contactId: true },
      });

      let target: (typeof stages)[number] | null = null;
      if (moveLeadsTo) {
        if (moveLeadsTo === stage.id) {
          throw new RouteError(400, "Choose a different stage to move the leads to.");
        }
        target = stages.find((s) => s.id === moveLeadsTo) ?? null;
        if (!target) throw new RouteError(404, "Destination stage not found");
      } else if (liveLeads.length > 0) {
        const n = liveLeads.length;
        throw new RouteError(
          409,
          `"${stage.name}" still has ${n} lead${n === 1 ? "" : "s"}. Choose a stage to move ${n === 1 ? "it" : "them"} to first.`,
          { code: "STAGE_HAS_LEADS", leadCount: n },
        );
      }

      const others = stages.filter((s) => s.id !== stage.id);
      // Leads the board doesn't show (archived, contact deleted) still point at the stage, and
      // the FK would leave them stageless: they go to the chosen stage, else "new" / the first.
      const destination = target ?? others.find((s) => s.slug === "new") ?? others[0] ?? null;
      let moved = 0;
      if (destination) {
        const update = await tx.lead.updateMany({
          where: { organisationId: session.organisationId, stageId: stage.id },
          data: { stageId: destination.id },
        });
        moved = update.count;
      }

      await tx.pipelineStage.delete({ where: { id: stage.id } });
      const remaining = await applyPositions(tx, others);
      return { stage, target, destination: moved > 0 ? destination : null, liveLeads, moved, remaining };
    });

    if (result.target && result.liveLeads.length > 0) {
      const target = result.target;
      await recordCrmActivities(
        result.liveLeads.map((lead) => ({
          organisationId: session.organisationId,
          kind: "stage_changed" as const,
          title: `Moved to ${target.name}`,
          body: `Stage "${result.stage.name}" was deleted.`,
          contactId: lead.contactId,
          leadId: lead.id,
          createdByUserId: session.userId,
          metadata: {
            fromStageId: result.stage.id,
            fromStageName: result.stage.name,
            toStageId: target.id,
            toStageName: target.name,
            reason: "stage_deleted",
          },
        })),
      );
    }

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "pipeline.stage_deleted",
      entityType: "PipelineStage",
      entityId: result.stage.id,
      metadata: {
        name: result.stage.name,
        slug: result.stage.slug,
        movedLeadsTo: result.destination?.id ?? null,
        movedLeads: result.moved,
      },
    });

    return Response.json({
      ok: true,
      deletedStageId: result.stage.id,
      movedLeads: result.moved,
      movedTo: result.destination?.id ?? null,
      stages: result.remaining.map(toStageDto),
    });
  } catch (error) {
    return routeErrorResponse(error, "Deleting the stage");
  }
}
