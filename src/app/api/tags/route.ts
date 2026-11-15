import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, requirePermissionForMutation } from "@/lib/session";
import { errorResponse, HttpError, readJsonBody } from "@/app/api/contacts/_lib/http";
import {
  DEFAULT_TAG_COLOR,
  findTagByName,
  isUniqueViolation,
  tagColorSchema,
  tagNameSchema,
} from "@/app/api/contacts/_lib/tags";

/**
 * GET /api/tags — the workspace's tags with how many live contacts carry each.
 */
export async function GET() {
  try {
    const session = await requirePermission("leads:read");
    const tags = await prisma.tag.findMany({
      where: { organisationId: session.organisationId },
      select: {
        id: true,
        name: true,
        color: true,
        createdAt: true,
        _count: { select: { contacts: { where: { contact: { deletedAt: null } } } } },
      },
      orderBy: { name: "asc" },
    });
    return Response.json({
      tags: tags.map(({ _count, ...tag }) => ({ ...tag, contactCount: _count.contacts })),
    });
  } catch (error) {
    return errorResponse(error, "Loading tags");
  }
}

const createSchema = z.object({
  name: tagNameSchema,
  color: tagColorSchema.optional().nullable(),
});

/**
 * POST /api/tags — { name, color? }. Names are unique per workspace (case-insensitive).
 */
export async function POST(req: Request) {
  try {
    const raw = await readJsonBody(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = createSchema.parse(raw);

    const clash = await findTagByName(session.organisationId, body.name);
    if (clash) throw new HttpError(409, `A tag called "${clash.name}" already exists.`, { tag: clash });

    try {
      const tag = await prisma.tag.create({
        data: {
          organisationId: session.organisationId,
          name: body.name,
          color: body.color ?? DEFAULT_TAG_COLOR,
        },
        select: { id: true, name: true, color: true, createdAt: true },
      });
      return Response.json({ tag: { ...tag, contactCount: 0 } }, { status: 201 });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, `A tag called "${body.name}" already exists.`);
      throw error;
    }
  } catch (error) {
    return errorResponse(error, "Creating the tag");
  }
}
