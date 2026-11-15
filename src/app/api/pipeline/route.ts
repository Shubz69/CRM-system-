import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, requirePermissionForMutation, jsonError, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";
import { roleHasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/services/audit";
import { recordCrmActivity } from "@/services/crm-activity";
import { zodMessage } from "./_lib/http";
import { moveLeadsMarkedHuman } from "./_lib/move-leads";
import { isSystemStageSlug } from "./_lib/stages";

export async function GET() {
  try {
    const session = await requirePermission("leads:read");
    const pipeline = await prisma.pipeline.findFirst({
      where: { organisationId: session.organisationId, isDefault: true },
      include: {
        stages: {
          orderBy: { position: "asc" },
          include: {
            leads: {
              // A deleted contact's leads leave the board.
              where: { deletedAt: null, contact: { deletedAt: null } },
              // Only what the board renders — not full contact rows (emails, phones, metadata).
              select: {
                id: true,
                score: true,
                qualificationStatus: true,
                stageId: true,
                contact: { select: { fullName: true, instagramUsername: true } },
              },
              orderBy: { updatedAt: "desc" },
            },
          },
        },
      },
    });

    return Response.json({
      pipeline: pipeline
        ? {
            ...pipeline,
            // Built-in stages (the AI moves leads by these slugs) can't be deleted.
            stages: pipeline.stages.map((stage) => ({
              ...stage,
              isSystem: isSystemStageSlug(stage.slug),
            })),
          }
        : null,
      // What the board may offer this person: stage editing and moving leads.
      permissions: {
        manageStages: roleHasPermission(session.role, "pipeline:manage"),
        moveLeads: roleHasPermission(session.role, "leads:write"),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const moveSchema = z.object({
  leadId: z.string({ required_error: "leadId is required" }).min(1, "leadId is required"),
  stageId: z.string({ required_error: "stageId is required" }).min(1, "stageId is required"),
});

export async function PATCH(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = moveSchema.parse(raw);

    const lead = await prisma.lead.findFirst({
      where: { id: body.leadId, organisationId: session.organisationId, deletedAt: null },
      include: { stage: { select: { name: true } } },
    });
    if (!lead) return jsonError("Lead not found", 404);

    const stage = await prisma.pipelineStage.findFirst({
      where: {
        id: body.stageId,
        pipeline: { organisationId: session.organisationId },
      },
    });
    if (!stage) return jsonError("Stage not found", 404);

    // A person's move wins: inbound AI analysis will not move this lead again. Metadata is
    // re-read under a row lock so concurrent AI writes (crmMemory, scores…) are kept.
    await moveLeadsMarkedHuman({
      organisationId: session.organisationId,
      leadIds: [lead.id],
      stageId: stage.id,
      userId: session.userId,
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "lead.stage_moved",
      entityType: "Lead",
      entityId: lead.id,
      metadata: { stageId: stage.id, stage: stage.name },
    });

    if (lead.stageId !== stage.id) {
      await recordCrmActivity({
        organisationId: session.organisationId,
        kind: "stage_changed",
        title: `Moved to ${stage.name}`,
        contactId: lead.contactId,
        leadId: lead.id,
        createdByUserId: session.userId,
        metadata: {
          fromStageId: lead.stageId,
          fromStageName: lead.stage?.name ?? null,
          toStageId: stage.id,
          toStageName: stage.name,
        },
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    if (error instanceof z.ZodError) return jsonError(zodMessage(error), 400);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
