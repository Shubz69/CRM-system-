import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  requirePermission,
  requirePermissionForMutation,
  jsonError,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { z } from "zod";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function parseNonNegativeInt(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function GET(req: Request) {
  try {
    const session = await requirePermission("leads:read");
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();

    const where: Prisma.ContactWhereInput = {
      organisationId: session.organisationId,
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { instagramUsername: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    // `total` counts the same rows the list is drawn from (it used to ignore `q`).
    if (searchParams.get("countOnly") === "1") {
      const total = await prisma.contact.count({ where });
      return Response.json({ organisationId: session.organisationId, total });
    }

    // Simple offset paging: ?limit=&offset= (defaults keep the old first-100 behaviour).
    const limit = Math.min(
      Math.max(parseNonNegativeInt(searchParams.get("limit")) ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = parseNonNegativeInt(searchParams.get("offset")) ?? 0;

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        include: {
          leads: {
            where: { deletedAt: null },
            take: 1,
            include: { stage: true },
            orderBy: { updatedAt: "desc" },
          },
          tags: { include: { tag: true } },
          company: { select: { id: true, name: true } },
          _count: { select: { conversations: true, bookings: true } },
        },
        // `id` breaks ties so pages never overlap or skip rows.
        orderBy: [{ lastContactAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit,
      }),
      prisma.contact.count({ where }),
    ]);

    const nextOffset = offset + contacts.length;
    return Response.json({
      organisationId: session.organisationId,
      contacts,
      total,
      limit,
      offset,
      nextOffset: nextOffset < total ? nextOffset : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(40).optional(),
  jobTitle: z.string().max(120).optional(),
  companyId: z.string().optional(),
  companyName: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  leadSource: z.string().max(80).optional(),
});

export async function POST(req: Request) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = createSchema.parse(raw);

    const email = body.email?.trim() || null;
    const phone = body.phone?.trim() || null;

    if (email) {
      const dup = await prisma.contact.findFirst({
        where: { organisationId: session.organisationId, deletedAt: null, email },
        select: { id: true },
      });
      if (dup) {
        return jsonError("A contact with this email already exists in this workspace.", 409);
      }
    }

    let companyId = body.companyId?.trim() || null;
    if (companyId) {
      const company = await prisma.company.findFirst({
        where: { id: companyId, organisationId: session.organisationId, deletedAt: null },
        select: { id: true },
      });
      if (!company) return jsonError("Company not found in this workspace.", 400);
      companyId = company.id;
    } else if (body.companyName?.trim()) {
      const existingCo = await prisma.company.findFirst({
        where: {
          organisationId: session.organisationId,
          deletedAt: null,
          name: { equals: body.companyName.trim(), mode: "insensitive" },
        },
        select: { id: true },
      });
      if (existingCo) companyId = existingCo.id;
      else {
        const createdCo = await prisma.company.create({
          data: {
            organisationId: session.organisationId,
            name: body.companyName.trim(),
          },
        });
        companyId = createdCo.id;
      }
    }

    const contact = await prisma.contact.create({
      data: {
        organisationId: session.organisationId,
        companyId,
        fullName: body.fullName.trim(),
        email,
        phone,
        leadSource: body.leadSource?.trim() || "manual",
        lastContactAt: new Date(),
        metadata: {
          provenance: "manual",
          jobTitle: body.jobTitle?.trim() || null,
          notes: body.notes?.trim() || null,
        },
      },
    });

    return Response.json({ id: contact.id, organisationId: session.organisationId }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    if (error instanceof z.ZodError) {
      return jsonError(error.issues[0]?.message || "Check the contact form and try again.", 400);
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
  }
}
