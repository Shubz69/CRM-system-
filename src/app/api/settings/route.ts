import { prisma } from "@/lib/db";
import { jsonError, requireSession } from "@/lib/session";

export async function GET() {
  try {
    const session = await requireSession();
    const [organisation, members, integrations, auditLogs] = await Promise.all([
      prisma.organisation.findUnique({ where: { id: session.organisationId } }),
      prisma.organisationMember.findMany({
        where: { organisationId: session.organisationId },
        include: { user: { select: { email: true, name: true } } },
      }),
      prisma.integration.findMany({ where: { organisationId: session.organisationId } }),
      prisma.auditLog.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    return Response.json({ organisation, members, integrations, auditLogs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
