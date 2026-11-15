import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { errorResponse, HttpError, readJsonBody } from "@/app/api/contacts/_lib/http";
import { canManageContacts, managerOnlyContactAction } from "@/components/contacts/contact-permissions";
import {
  findTagByName,
  isUniqueViolation,
  tagColorSchema,
  tagNameSchema,
} from "@/app/api/contacts/_lib/tags";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    name: tagNameSchema.optional(),
    color: tagColorSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: "Send a new name or colour.",
  });

/** Renaming, recolouring or deleting a tag changes every contact carrying it. */
function assertMayManageTags(role: string | null | undefined): void {
  if (!canManageContacts(role)) {
    throw new HttpError(403, managerOnlyContactAction("renaming, recolouring or deleting tags"));
  }
}

async function findOrgTag(organisationId: string, id: string) {
  const tag = await prisma.tag.findFirst({
    where: { id, organisationId },
    select: { id: true, name: true, color: true },
  });
  if (!tag) throw new HttpError(404, "Tag not found");
  return tag;
}

/** PATCH /api/tags/[id] — rename and/or recolour. Owner / Administrator / Manager only. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const raw = await readJsonBody(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    assertMayManageTags(session.role);
    const { id } = await params;
    const body = patchSchema.parse(raw);
    const tag = await findOrgTag(session.organisationId, id);

    if (body.name !== undefined) {
      const clash = await findTagByName(session.organisationId, body.name, tag.id);
      if (clash) throw new HttpError(409, `A tag called "${clash.name}" already exists.`);
    }

    try {
      const updated = await prisma.tag.update({
        where: { id: tag.id },
        data: { name: body.name, color: body.color },
        select: { id: true, name: true, color: true },
      });
      return Response.json({ tag: updated });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, `A tag called "${body.name}" already exists.`);
      throw error;
    }
  } catch (error) {
    return errorResponse(error, "Updating the tag");
  }
}

/**
 * DELETE /api/tags/[id] — removes the tag from every contact and conversation.
 * Owner / Administrator / Manager only.
 */
export async function DELETE(req: Request, { params }: Params) {
  try {
    const session = await requirePermissionForMutation("leads:write", req);
    assertMayManageTags(session.role);
    const { id } = await params;
    const tag = await findOrgTag(session.organisationId, id);
    // Scoped delete: a tag id from another workspace can never be removed.
    await prisma.tag.deleteMany({ where: { id: tag.id, organisationId: session.organisationId } });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "tags.delete",
      entityType: "Tag",
      entityId: tag.id,
      metadata: { name: tag.name },
    }).catch(() => undefined);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Deleting the tag");
  }
}
