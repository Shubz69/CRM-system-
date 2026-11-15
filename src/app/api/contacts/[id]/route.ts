import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission, requirePermissionForMutation, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";
import { applyOptOut, clearOptOut } from "@/services/opt-out";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(100).nullable().optional(),
  note: z.string().trim().min(1).max(10_000).optional(),
  tagIds: z.array(z.string()).optional(),
  optedOut: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

export async function GET(_req: Request, { params }: Params) {
  try {
    const session = await requirePermission("leads:read");
    const { id } = await params;
    const contact = await prisma.contact.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      include: {
        leads: { where: { deletedAt: null }, include: { stage: true }, orderBy: { updatedAt: "desc" } },
        conversations: { where: { deletedAt: null }, orderBy: { lastMessageAt: "desc" }, take: 10 },
        bookings: { orderBy: { createdAt: "desc" } },
        notes: { include: { author: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "desc" } },
        tags: { include: { tag: true } },
        attributions: { include: { campaign: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!contact) return jsonError("Contact not found", 404);
    return Response.json({ contact });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const { id } = await params;
    const body = patchSchema.parse(raw);
    const contact = await prisma.contact.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) return jsonError("Contact not found", 404);

    // Same rule as creating a contact: one live contact per email in a workspace.
    if (body.email) {
      const dup = await prisma.contact.findFirst({
        where: { organisationId: session.organisationId, deletedAt: null, email: body.email, id: { not: id } },
        select: { id: true },
      });
      if (dup) return jsonError("A contact with this email already exists in this workspace.", 409);
    }

    if (body.optedOut !== undefined) {
      if (body.optedOut) {
        await applyOptOut({ organisationId: session.organisationId, contactId: id, userId: session.userId, source: "manual" });
      } else {
        await clearOptOut({ organisationId: session.organisationId, contactId: id, userId: session.userId });
      }
    }
    if (body.note) {
      await prisma.note.create({ data: { organisationId: session.organisationId, contactId: id, authorId: session.userId, body: body.note } });
    }
    if (body.tagIds) {
      const validTags = await prisma.tag.findMany({ where: { id: { in: body.tagIds }, organisationId: session.organisationId }, select: { id: true } });
      await prisma.contactTag.deleteMany({ where: { contactId: id } });
      await prisma.contactTag.createMany({ data: validTags.map((tag) => ({ contactId: id, tagId: tag.id })) });
    }
    if (
      body.fullName !== undefined ||
      body.email !== undefined ||
      body.phone !== undefined ||
      body.deleted !== undefined
    ) {
      await prisma.contact.update({
        where: { id },
        data: {
          fullName: body.fullName,
          email: body.email,
          phone: body.phone,
          deletedAt: body.deleted ? new Date() : undefined,
        },
      });
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    if (error instanceof z.ZodError) {
      return jsonError(error.issues[0]?.message || "Check the contact details and try again.", 400);
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
