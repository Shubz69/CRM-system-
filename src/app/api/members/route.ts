import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";

export async function GET() {
  try {
    const session = await requirePermission("inbox:read");
    const members = await prisma.organisationMember.findMany({
      where: { organisationId: session.organisationId },
      select: { role: true, user: { select: { id: true, name: true, email: true } } },
      orderBy: { user: { name: "asc" } },
    });
    return Response.json({ members: members.map(({ role, user }) => ({ ...user, role })) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
