import { jsonError, requirePermission } from "@/lib/session";
import { disconnectSocialConnection } from "@/services/social-connections";
import { writeAuditLog } from "@/services/audit";

type Params = { params: Promise<{ id: string }> };

/** DELETE /api/social/connections/[id] — revokes locally (deletes stored tokens). */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const session = await requirePermission("integrations:manage");
    const { id } = await params;

    const connection = await disconnectSocialConnection(session.organisationId, id);
    if (!connection) return jsonError("Connection not found", 404);

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "social_connection.disconnected",
      entityType: "SocialConnection",
      entityId: connection.id,
    });

    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
