import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { recordCrmActivity } from "@/services/crm-activity";
import { errorResponse, HttpError, readJsonBody } from "../../_lib/http";
import { createLeadsForContacts, resolveTargetStage } from "../../_lib/leads";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  stageId: z.string().trim().min(1, "Pick a stage.").max(100).optional().nullable(),
});

/**
 * POST /api/contacts/[id]/lead — put a contact on the pipeline.
 * Body (optional): { stageId } — a stage of the default pipeline; defaults to its "new" stage
 * (or its first stage when there is none).
 * 201 { lead } · 409 when the contact already has a live lead (body carries that lead).
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const raw = await readJsonBody(req, { allowEmpty: true });
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const { id } = await params;
    const body = bodySchema.parse(raw);

    const contact = await prisma.contact.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      select: { id: true, fullName: true },
    });
    if (!contact) throw new HttpError(404, "Contact not found");

    const liveLead = await prisma.lead.findFirst({
      where: { contactId: id, organisationId: session.organisationId, deletedAt: null },
      select: { id: true, stage: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
    });
    if (liveLead) {
      throw new HttpError(409, "This contact is already in the pipeline.", { lead: liveLead });
    }

    const target = await resolveTargetStage(session.organisationId, body.stageId);
    const result = await createLeadsForContacts({
      organisationId: session.organisationId,
      contactIds: [id],
      target,
      userId: session.userId,
    });
    const lead = result.created[0];
    if (!lead) {
      // Another request added the contact between our check and the locked insert.
      throw new HttpError(409, "This contact is already in the pipeline.");
    }

    await recordCrmActivity({
      organisationId: session.organisationId,
      kind: "added_to_pipeline",
      title: `Added to pipeline · ${target.stage.name}`,
      contactId: id,
      leadId: lead.id,
      createdByUserId: session.userId,
      metadata: { pipelineId: target.pipelineId, stageId: target.stage.id, stageName: target.stage.name },
    });

    return Response.json(
      { lead: { id: lead.id, stage: target.stage, pipelineId: target.pipelineId } },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, "Adding the contact to the pipeline");
  }
}
