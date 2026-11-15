import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { recordCrmActivity } from "@/services/crm-activity";
import { errorResponse, HttpError } from "../../../_lib/http";

type Params = { params: Promise<{ id: string; tagId: string }> };

/** DELETE /api/contacts/[id]/tags/[tagId] — remove one tag from a contact. */
export async function DELETE(req: Request, { params }: Params) {
  try {
    const session = await requirePermissionForMutation("leads:write", req);
    const { id, tagId } = await params;

    const [contact, tag] = await Promise.all([
      prisma.contact.findFirst({
        where: { id, organisationId: session.organisationId, deletedAt: null },
        select: { id: true },
      }),
      prisma.tag.findFirst({
        where: { id: tagId, organisationId: session.organisationId },
        select: { id: true, name: true },
      }),
    ]);
    if (!contact) throw new HttpError(404, "Contact not found");
    if (!tag) throw new HttpError(404, "Tag not found");

    const { count } = await prisma.contactTag.deleteMany({ where: { contactId: id, tagId: tag.id } });
    if (count > 0) {
      await recordCrmActivity({
        organisationId: session.organisationId,
        kind: "tagged",
        title: `Removed tag "${tag.name}"`,
        contactId: id,
        createdByUserId: session.userId,
        metadata: { removed: [{ id: tag.id, name: tag.name }] },
      });
    }
    return Response.json({ ok: true, removed: count > 0 });
  } catch (error) {
    return errorResponse(error, "Removing the tag");
  }
}
