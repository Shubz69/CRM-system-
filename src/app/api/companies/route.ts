import { NextRequest } from "next/server";
import { z } from "zod";
import {
  requirePermission,
  requirePermissionForMutation,
  jsonError,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { prisma } from "@/lib/db";
import { readableZodError } from "@/lib/readable-zod";
import { upsertCompany } from "@/services/crm-v2";

/** Live (not soft-deleted) related rows only. */
const liveCounts = {
  _count: {
    select: {
      contacts: { where: { deletedAt: null } },
      deals: { where: { deletedAt: null } },
    },
  },
} as const;

export async function GET(req: Request) {
  try {
    const session = await requirePermission("leads:read");
    const where = { organisationId: session.organisationId, deletedAt: null };

    // Overview pages only need the number — a real count, not the length of the capped list.
    if (new URL(req.url).searchParams.get("countOnly") === "1") {
      const total = await prisma.company.count({ where });
      return Response.json({ total, organisationId: session.organisationId });
    }

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 100,
        include: liveCounts,
      }),
      prisma.company.count({ where }),
    ]);
    return Response.json({ companies, total, organisationId: session.organisationId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(200).optional(),
  website: z.string().url().optional(),
  industry: z.string().max(100).optional(),
  sizeBand: z.string().max(40).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = createSchema.parse(raw);
    // Adding a company whose name is already taken used to merge into (and overwrite) the
    // existing one while saying "Company saved". Point at it instead, like rename does.
    const existing = await prisma.company.findFirst({
      where: {
        organisationId: session.organisationId,
        name: { equals: body.name.trim(), mode: "insensitive" },
        deletedAt: null,
      },
      select: { id: true, name: true },
    });
    if (existing) {
      return Response.json(
        {
          error: `A company called "${existing.name}" already exists. Open it to edit it instead.`,
          code: "DUPLICATE_COMPANY",
          existingId: existing.id,
        },
        { status: 409 },
      );
    }
    const id = await upsertCompany({
      organisationId: session.organisationId,
      ...body,
    });
    return Response.json({ id, organisationId: session.organisationId });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    if (error instanceof z.ZodError) {
      return jsonError(
        readableZodError(error, {
          name: "Company name",
          domain: "Domain",
          website: "Website",
          industry: "Industry",
          sizeBand: "Size",
        }),
        400,
      );
    }
    if (error instanceof SyntaxError) return jsonError("Invalid request body.", 400);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (message === "Company name is required") return jsonError("Company name is required.", 400);
    return jsonError("Couldn't save the company. Try again.", 500);
  }
}
