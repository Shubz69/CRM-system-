import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";

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
        _count: { select: { conversations: true, bookings: true } },
      },
      orderBy: { lastContactAt: "desc" },
      take: 100,
    });

    return Response.json({ contacts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
