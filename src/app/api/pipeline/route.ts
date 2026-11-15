import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { markHumanLeadChange } from "@/services/lead-stage-guard";
import { requirePermission, requirePermissionForMutation, jsonError, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";

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

    return Response.json({ pipeline });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

const moveSchema = z.object({
  leadId: z.string(),
  stageId: z.string(),
});

export async function PATCH(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = moveSchema.parse(raw);

    const lead = await prisma.lead.findFirst({
      where: { id: body.leadId, organisationId: session.organisationId, deletedAt: null },
    });
    if (!lead) return jsonError("Lead not found", 404);

    const stage = await prisma.pipelineStage.findFirst({
      where: {
        id: body.stageId,
        pipeline: { organisationId: session.organisationId },
      },
    });
    if (!stage) return jsonError("Stage not found", 404);

    await prisma.lead.updateMany({
      where: { id: lead.id, organisationId: session.organisationId },
      data: {
        stageId: stage.id,
        // A person's move wins: inbound AI analysis will not move this lead again.
        metadata: markHumanLeadChange(lead.metadata, {
          stage: true,
          userId: session.userId,
        }) as Prisma.InputJsonValue,
      },
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "lead.stage_moved",
      entityType: "Lead",
      entityId: lead.id,
      metadata: { stageId: stage.id, stage: stage.name },
    });

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
