import { NextRequest } from "next/server";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requirePermission("leads:read");
    const { id } = await context.params;
    const company = await prisma.company.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      include: {
        contacts: {
          where: { deletedAt: null },
          orderBy: { lastContactAt: "desc" },
          take: 50,
          select: { id: true, fullName: true, email: true, lastContactAt: true },
        },
        deals: {
          where: { deletedAt: null },
          orderBy: { updatedAt: "desc" },
          take: 20,
          select: { id: true, name: true, status: true, amountCents: true, currency: true },
        },
        _count: { select: { contacts: true, deals: true } },
      },
    });
    if (!company) return jsonError("Company not found", 404);
    return Response.json({ organisationId: session.organisationId, company });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
