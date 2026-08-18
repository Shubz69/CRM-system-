import { jsonError, requirePermission } from "@/lib/session";
import { listSocialConnections } from "@/services/social-connections";
import { listSocialProviderAdapters } from "@/adapters/social";
import { socialPlatformSlug } from "@/lib/social-platform";

/** GET /api/social/connections — this org's connections + capability metadata for every platform. */
export async function GET() {
  try {
    const session = await requirePermission("integrations:manage");
    const connections = await listSocialConnections(session.organisationId);

    const platforms = listSocialProviderAdapters().map((adapter) => {
      const connection = connections.find((c) => c.platform === adapter.platform);
      return {
        platform: adapter.platform,
        slug: socialPlatformSlug(adapter.platform),
        displayName: adapter.displayName,
        capabilities: adapter.capabilities,
        configured: adapter.isConfigured(),
        connection: connection
          ? {
              id: connection.id,
              displayName: connection.displayName,
              status: connection.status,
              scopes: connection.scopes,
              expiresAt: connection.expiresAt,
              lastSyncedAt: connection.lastSyncedAt,
              createdAt: connection.createdAt,
            }
          : null,
      };
    });

    return Response.json({ platforms });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
