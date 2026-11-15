import { z } from "zod";
import { prisma } from "@/lib/db";
import { roleHasPermission } from "@/lib/permissions";
import {
  jsonError,
  requireSession,
  requireSessionForMutation,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { tenantAuditLogWhere, writeAuditLog } from "@/services/audit";

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

/** Workspace roles that may change workspace-wide settings such as the timezone. */
const TIMEZONE_EDIT_ROLES = new Set(["OWNER", "ADMINISTRATOR", "SUPER_ADMIN"]);

/**
 * Canonical IANA name ("europe/london" → "Europe/London"), or null when the runtime
 * doesn't know the zone. Offsets like "+05:00" are rejected: they ignore daylight saving.
 */
function canonicalTimeZone(value: string): string | null {
  const zone = value.trim();
  if (!zone || zone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const patchSchema = z.object({ timezone: z.string() });

/** PATCH /api/settings — owners/admins update the workspace timezone. */
export async function PATCH(req: Request) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonError("Invalid request body.", 400);
    }
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const session = await requireSessionForMutation(req, body);
    if (!TIMEZONE_EDIT_ROLES.has(session.role)) {
      return jsonError("Only workspace owners and admins can change the timezone.", 403);
    }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return jsonError("Choose a timezone.", 400);
    const timezone = canonicalTimeZone(parsed.data.timezone);
    if (!timezone) {
      return jsonError("That isn't a recognised timezone. Pick one from the list, e.g. Europe/London.", 400);
    }
    const existing = await prisma.organisation.findUnique({
      where: { id: session.organisationId },
      select: { timezone: true },
    });
    if (!existing) return jsonError("Workspace not found", 404);
    if (existing.timezone === timezone) {
      return Response.json({ ok: true, organisation: { timezone } });
    }
    const updated = await prisma.organisation.update({
      where: { id: session.organisationId },
      data: { timezone },
      select: { timezone: true },
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "workspace.timezone_updated",
      entityType: "Organisation",
      entityId: session.organisationId,
      metadata: { from: existing.timezone, to: updated.timezone },
    });
    return Response.json({ ok: true, organisation: { timezone: updated.timezone } });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) {
      return jsonError("Only workspace owners and admins can change the timezone.", 403);
    }
    return jsonError("Couldn't update the timezone. Try again.", 500);
  }
}
