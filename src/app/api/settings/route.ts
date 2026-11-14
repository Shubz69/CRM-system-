import { prisma } from "@/lib/db";
import { roleHasPermission } from "@/lib/permissions";
import { jsonError, requireSession } from "@/lib/session";
import { tenantAuditLogWhere } from "@/services/audit";

export async function GET() {
  try {
    const session = await requireSession();
    // Audit logs used to be returned to every role here, bypassing audit:read.
    const canReadSettings = roleHasPermission(session.role, "settings:read");
    const canReadAudit = roleHasPermission(session.role, "audit:read");
    const [organisation, members, integrations, auditLogs] = await Promise.all([
      prisma.organisation.findUnique({ where: { id: session.organisationId } }),
      prisma.organisationMember.findMany({
        where: { organisationId: session.organisationId },
        include: { user: { select: { email: true, name: true } } },
      }),
      canReadSettings
        ? prisma.integration.findMany({ where: { organisationId: session.organisationId } })
        : Promise.resolve([]),
      canReadAudit
        ? prisma.auditLog.findMany({
            where: tenantAuditLogWhere(session.organisationId),
            orderBy: { createdAt: "desc" },
            take: 20,
          })
        : Promise.resolve([]),
    ]);
    return Response.json({ organisation, members, integrations, auditLogs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
