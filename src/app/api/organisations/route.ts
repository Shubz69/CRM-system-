import { prisma } from "@/lib/db";
import { jsonError, requireSession } from "@/lib/session";

export async function GET() {
  try {
    const session = await requireSession();
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { updatedAt: true, activeOrganisationId: true },
    });
    const memberships = await prisma.organisationMember.findMany({
      where: { userId: session.userId },
      include: { organisation: { select: { id: true, name: true, slug: true, demoData: true } } },
      orderBy: { createdAt: "asc" },
    });

    return Response.json({
      activeOrganisationId: user?.activeOrganisationId || session.organisationId,
      workspaceRevision: user?.updatedAt.toISOString() || null,
      organisations: memberships.map((m) => ({
        id: m.organisation.id,
        name: m.organisation.name,
        slug: m.organisation.slug,
        role: m.role,
        demoData: m.organisation.demoData,
        isActive: m.organisationId === session.organisationId,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
