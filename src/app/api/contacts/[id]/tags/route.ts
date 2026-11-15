import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { recordCrmActivity } from "@/services/crm-activity";
import { errorResponse, HttpError, readJsonBody } from "../../_lib/http";
import { findOrCreateTag, tagColorSchema, tagNameSchema } from "../../_lib/tags";

type Params = { params: Promise<{ id: string }> };

const byIdSchema = z.object({ tagId: z.string().trim().min(1, "Pick a tag.").max(100) });
const byNameSchema = z.object({ name: tagNameSchema, color: tagColorSchema.optional().nullable() });

/**
 * POST /api/contacts/[id]/tags — tag a contact.
 * Body: { tagId } to use an existing tag, or { name, color? } to pick-or-create by name.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const raw = await readJsonBody(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const { id } = await params;
    const body = "tagId" in raw ? byIdSchema.parse(raw) : byNameSchema.parse(raw);

    const contact = await prisma.contact.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) throw new HttpError(404, "Contact not found");

    let tag: { id: string; name: string; color: string };
    let tagCreated = false;
    if ("tagId" in body) {
      const found = await prisma.tag.findFirst({
        where: { id: body.tagId, organisationId: session.organisationId },
        select: { id: true, name: true, color: true },
      });
      if (!found) throw new HttpError(404, "Tag not found");
      tag = found;
    } else {
      const result = await findOrCreateTag(session.organisationId, body.name, body.color ?? undefined);
      tag = result.tag;
      tagCreated = result.created;
    }

    const { count } = await prisma.contactTag.createMany({
      data: [{ contactId: id, tagId: tag.id }],
      skipDuplicates: true,
    });
    if (count > 0) {
      await recordCrmActivity({
        organisationId: session.organisationId,
        kind: "tagged",
        title: `Tagged "${tag.name}"`,
        contactId: id,
        createdByUserId: session.userId,
        metadata: { added: [{ id: tag.id, name: tag.name }] },
      });
    }

    return Response.json({ tag, added: count > 0, tagCreated }, { status: count > 0 ? 201 : 200 });
  } catch (error) {
    return errorResponse(error, "Tagging the contact");
  }
}
