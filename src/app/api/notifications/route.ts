import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requireSession } from "@/lib/session";

const patchSchema = z.object({ id: z.string().optional(), all: z.boolean().optional() });

export async function GET() {
  try {
    const session = await requireSession();
    const where = { organisationId: session.organisationId, OR: [{ userId: session.userId }, { userId: null }] };
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 50 }),
      // Real unread total — not just among the 50 most recent.
      prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return Response.json({ notifications, unreadCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await requireSession();
    const body = patchSchema.parse(await req.json());
    if (!body.id && !body.all) return jsonError("id or all is required");
    await prisma.notification.updateMany({
      // readAt: null keeps the original read time of notifications already read.
      where: { organisationId: session.organisationId, OR: [{ userId: session.userId }, { userId: null }], readAt: null, ...(body.all ? {} : { id: body.id }) },
      data: { readAt: new Date() },
    });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
  }
}
