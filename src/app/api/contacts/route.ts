import { prisma } from "@/lib/db";
import {
  requirePermission,
  requirePermissionForMutation,
  jsonError,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { z } from "zod";

export async function GET(req: Request) {
  try {
    const session = await requirePermission("leads:read");
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();

    const contacts = await prisma.contact.findMany({
      where: {
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
      },
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
      orderBy: { lastContactAt: "desc" },
      take: 100,
    });

    const total = await prisma.contact.count({
      where: { organisationId: session.organisationId, deletedAt: null },
    });

    return Response.json({
      organisationId: session.organisationId,
      contacts,
      total,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
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
