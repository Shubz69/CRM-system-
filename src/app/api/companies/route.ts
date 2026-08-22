import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";
import { upsertCompany } from "@/services/crm-v2";

export async function GET() {
  try {
    const session = await requirePermission("leads:read");
    const companies = await prisma.company.findMany({
      where: { organisationId: session.organisationId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { _count: { select: { contacts: true, deals: true } } },
    });
    return Response.json({ companies });
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
    const session = await requirePermission("leads:write");
    const body = createSchema.parse(await req.json());
    const id = await upsertCompany({
      organisationId: session.organisationId,
      ...body,
    });
    return Response.json({ id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
